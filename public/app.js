// Safeguard for i18next to prevent duplicate initialization and debug output in production
if (typeof window !== 'undefined') {
  const setupI18nInterceptor = (instance) => {
    if (instance && typeof instance.init === 'function' && !instance.__antigravity_intercepted) {
      instance.__antigravity_intercepted = true;
      const originalInit = instance.init;
      let initialized = false;
      instance.init = function(options, ...args) {
        if (initialized) {
          console.warn('i18next: Prevented duplicate initialization');
          return instance;
        }
        initialized = true;
        options = options || {};
        options.debug = false; // Disable verbose console logs in production
        return originalInit.call(this, options, ...args);
      };
    }
  };

  if (window.i18next) {
    setupI18nInterceptor(window.i18next);
  } else {
    let _i18next = undefined;
    Object.defineProperty(window, 'i18next', {
      configurable: true,
      enumerable: true,
      get() {
        return _i18next;
      },
      set(val) {
        _i18next = val;
        setupI18nInterceptor(val);
      }
    });
  }
}

// Live hosted website URL
// Jab aap isko push karein ge, to mobile APK automatic live website ke database se connect ho jaye ga.
const LIVE_BACKEND_URL = 'https://business-management-hub.britsync.co.uk';

const isMobileApp = window.Capacitor || 
                    window.location.protocol.startsWith('capacitor');
const isDesktopApp = navigator.userAgent.toLowerCase().includes('electron');
const isApp = isMobileApp || isDesktopApp || window.location.protocol === 'file:';

const API_URL = (window.location.origin.includes('localhost') || window.location.hostname === '127.0.0.1')
  ? 'http://localhost:5000'
  : LIVE_BACKEND_URL;
let currentUser = null;
let currentToken = null;
let currentBusiness = null; // Stored if user is a Business Owner
let activeTab = 'dashboard';
let chartsInstance = null; // Holds the business analytics Chart.js instance

// Safe JSON parser - prevents "Unexpected token" crash when server returns HTML
async function safeJson(res) {
  const ct = res.headers.get('content-type') || '';
  if (!ct.includes('application/json')) {
    throw new Error('Server returned non-JSON response. Please restart the server.');
  }
  return res.json();
}

// Global fix: override Response.json to be safe everywhere
const _origFetch = window.fetch;
window.fetch = async function(...args) {
  const res = await _origFetch.apply(this, args);
  const origJson = res.json.bind(res);
  res.json = async function() {
    const ct = res.headers.get('content-type') || '';
    if (!ct.includes('application/json')) {
      throw new Error('Server returned non-JSON response. Please restart the server.');
    }
    return origJson();
  };
  return res;
};

let allVoices = [];
function loadVoices() {
  if ('speechSynthesis' in window) {
    allVoices = window.speechSynthesis.getVoices();
  }
}
if ('speechSynthesis' in window) {
  loadVoices();
  window.speechSynthesis.onvoiceschanged = loadVoices;
}

// --- TEAM CHAT & WEBRTC CALLING STATES ---
let activeChatPartnerId = null;
let chatPollInterval = null;
let allChatUsers = [];

let localStream = null;
let peerConnection = null;
let webrtcSignalInterval = null;
let webrtcIsMicMuted = false;
let webrtcIsCamOff = false;

// On page load, check authentication status and onboarding state
window.addEventListener('DOMContentLoaded', () => {
  // Request notification permission early
  if ("Notification" in window && Notification.permission === "default") {
    Notification.requestPermission().catch(err => console.warn("Failed to request notification permission:", err));
  }

  // Listen for service worker messages (chat notification clicks)
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', (event) => {
      if (event.data && event.data.type === 'OPEN_CHAT') {
        if (currentUser) {
          switchMainTab('team-chat');
        }
      }
    });
  }

  const savedToken = localStorage.getItem('token');
  const savedUser = localStorage.getItem('user');
  const savedBusiness = localStorage.getItem('business');
  
  const onboardingCompleted = localStorage.getItem('onboarding-completed');

  if (isApp && onboardingCompleted !== 'true') {
    // Present the premium onboarding flow first
    document.getElementById('onboarding-container').classList.remove('hidden');
    initOnboardingCarousel();
  } else {
    if (savedToken && savedUser) {
      currentToken = savedToken;
      currentUser = JSON.parse(savedUser);
      if (savedBusiness) currentBusiness = JSON.parse(savedBusiness);
      initCommandShell();
    } else {
      if (isApp) {
        // App containers go directly to login overlay
        showAuthPanel();
      } else {
        // Web loads default landing page
        document.getElementById('landing-page-container').classList.remove('hidden');
      }
    }
  }
});

// --- AUTH & NAVIGATION CONTROLLERS ---

function showAuthPanel() {
  document.getElementById('auth-panel').classList.remove('hidden');
  switchAuthTab('login');
}

function hideAuthPanel() {
  document.getElementById('auth-panel').classList.add('hidden');
}

function initCommandShell() {
  document.getElementById('auth-panel').classList.add('hidden');
  document.getElementById('landing-page-container').classList.add('hidden');
  document.getElementById('command-shell').classList.remove('hidden');

  // Setup user details display
  document.getElementById('shell-username-display').innerText = currentUser.full_name;
  document.getElementById('shell-email-display').innerText = currentUser.email;
  document.getElementById('shell-role-display').innerText = currentUser.role;
  document.getElementById('welcome-name').innerText = currentUser.full_name;
  
  // Set avatar letters
  const parts = currentUser.full_name.split(' ');
  const letters = parts.map(p => p[0]).join('').toUpperCase().slice(0, 2);
  document.getElementById('avatar-letters').innerText = letters;

  // Set roles navigation visibility
  document.querySelector('.admin-links').classList.add('hidden');
  document.querySelector('.boss-links').classList.add('hidden');
  document.querySelector('.owner-links').classList.add('hidden');
  document.querySelector('.editor-links').classList.add('hidden');
  document.querySelector('.smm-links').classList.add('hidden');
  document.querySelector('.mentee-links').classList.add('hidden');
  document.querySelector('.fsdev-links').classList.add('hidden');
  document.querySelector('.webdev-links').classList.add('hidden');
  document.querySelector('.aieng-links').classList.add('hidden');

  if (['Super Admin', 'Admin Team'].includes(currentUser.role)) {
    document.querySelector('.admin-links').classList.remove('hidden');
  }
  if (currentUser.role === 'Super Admin') {
    document.querySelector('.boss-links').classList.remove('hidden');
  }
  if (currentUser.role === 'Business Owners') {
    document.querySelector('.owner-links').classList.remove('hidden');
  } else if (currentUser.role === 'Video Editors') {
    document.querySelector('.editor-links').classList.remove('hidden');
  } else if (currentUser.role === 'Social Media Managers') {
    document.querySelector('.smm-links').classList.remove('hidden');
  } else if (currentUser.role === 'Mentorship Members') {
    document.querySelector('.mentee-links').classList.remove('hidden');
  } else if (currentUser.role === 'Full Stack Developers') {
    document.querySelector('.fsdev-links').classList.remove('hidden');
  } else if (currentUser.role === 'Web Developers') {
    document.querySelector('.webdev-links').classList.remove('hidden');
  } else if (currentUser.role === 'AI Engineers') {
    document.querySelector('.aieng-links').classList.remove('hidden');
  }

  // Set visibility of the AI Voice Assistant Card based on authorization
  const voicePanel = document.getElementById('ai-voice-panel');
  if (voicePanel) {
    if (['Super Admin', 'Admin Team'].includes(currentUser.role)) {
      voicePanel.classList.remove('hidden');
    } else {
      voicePanel.classList.add('hidden');
    }
  }

  // Load appropriate data and select dashboard view
  switchMainTab('dashboard');
  loadNotifications();
  startNotificationsPoll();
  initPushNotifications();
}

function switchAuthTab(tab) {
  // Reset tabs
  document.getElementById('tab-login-btn').classList.remove('active');
  document.getElementById('tab-register-owner-btn').classList.remove('active');
  document.getElementById('tab-register-general-btn').classList.remove('active');

  document.getElementById('login-form').classList.remove('active-form');
  document.getElementById('register-owner-form').classList.remove('active-form');
  document.getElementById('register-general-form').classList.remove('active-form');

  if (tab === 'login') {
    document.getElementById('tab-login-btn').classList.add('active');
    document.getElementById('login-form').classList.add('active-form');
  } else if (tab === 'register-owner') {
    document.getElementById('tab-register-owner-btn').classList.add('active');
    document.getElementById('register-owner-form').classList.add('active-form');
  } else if (tab === 'register-general') {
    document.getElementById('tab-register-general-btn').classList.add('active');
    document.getElementById('register-general-form').classList.add('active-form');
  }
}

// Force chat layout to exact pixel sizes so flex/grid children can scroll
function sizeChatLayout() {
  // CSS handles layout via position:absolute — no JS sizing needed
}

function switchMainTab(tabId) {
  activeTab = tabId;
  
  // Close mobile sidebar if open
  const sidebar = document.querySelector('.sidebar');
  const overlay = document.getElementById('sidebar-overlay');
  if (sidebar && sidebar.classList.contains('sidebar-open')) {
    sidebar.classList.remove('sidebar-open');
  }
  if (overlay && overlay.classList.contains('active')) {
    overlay.classList.remove('active');
  }
  
  // Highlight active sidebar menu item
  document.querySelectorAll('.nav-item').forEach(item => {
    item.classList.remove('active');
  });

  // Clear Chat Polling when switching away from chat
  if (tabId !== 'team-chat') {
    if (chatPollInterval) {
      clearInterval(chatPollInterval);
      chatPollInterval = null;
    }
    activeChatPartnerId = null;
  }

  // Find sidebar items that trigger this tabId and add active class
  const activeLink = Array.from(document.querySelectorAll('.nav-item')).find(item => {
    return item.getAttribute('onclick') && item.getAttribute('onclick').includes(tabId);
  });
  if (activeLink) activeLink.classList.add('active');

  // Change title display
  const titleMap = {
    'dashboard': 'Platform Command Dashboard',
    'team-chat': 'Corporate Operations Chat Room',
    'admin-businesses': 'Partner Portfolio Administration',
    'admin-content': 'Content Workflow Pipeline',
    'admin-meetings': 'Scheduled Weekly Briefings',
    'admin-mentorship': 'Incubator Mentorship Board',
    'admin-invites': 'Invitation Link Generation',
    'owner-profile': 'My Business Profile',
    'owner-reports': 'Daily Operational Progress Reports',
    'owner-content': 'Content Desk Uploads',
    'owner-invoices': 'Client Invoicing Workspace',
    'owner-meetings': 'Scheduled Weekly briefings',
    'editor-dashboard': 'Video Production Desk',
    'smm-dashboard': 'Social Channels Dispatcher',
    'mentee-workspace': 'Mentorship Advisement Desk',
    'meeting-room': 'Virtual Sync & Operations Room',
    'fsdev-dashboard': 'Full Stack Development Desk',
    'fsdev-tasks': 'Full Stack Task Manager',
    'webdev-dashboard': 'Web Development Desk',
    'webdev-tasks': 'Web Developer Task Manager',
    'aieng-dashboard': 'AI Development Desk',
    'aieng-tasks': 'AI Engineer Task Manager',
    'admin-meeting-tasks': 'Meeting Task Approvals',
    'owner-meeting-tasks': 'Submit Task for Approval',
    'editor-meetings': 'Editor Meetings',
    'smm-meetings': 'SMM Meetings',
    'mentee-meetings': 'Mentee Meetings',
    'owner-projects': 'Submit Project Request',
    'assigned-projects': 'My Assigned Projects',
    'admin-projects': 'Project Approvals',
    'workspaces': 'Workspaces',
    'workspace-detail': 'Workspace Channel'
  };
  document.getElementById('header-view-title').innerText = titleMap[tabId] || 'Platform Dashboard';

  // Toggle active view panel
  document.querySelectorAll('.dashboard-view').forEach(view => {
    view.classList.remove('active');
  });
  const activeView = document.getElementById(`view-${tabId}`);
  if (activeView) activeView.classList.add('active');

  // Toggle chat-active class on container to disable parent scrolling when chat is open
  const viewsContainer = document.querySelector('.dashboard-views-container');
  if (viewsContainer) {
    viewsContainer.classList.toggle('chat-active', tabId === 'team-chat');
  }

  // Force chat layout sizing after DOM update
  if (tabId === 'team-chat') {
    requestAnimationFrame(() => sizeChatLayout());
  }

  // Fetch relevant tab data
  fetchTabData(tabId);
}

// --- API ACTIONS HANDLERS ---

async function handleLogin(e) {
  e.preventDefault();
  const email = document.getElementById('login-email').value;
  const password = document.getElementById('login-password').value;

  try {
    const response = await fetch(`${API_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });
    const data = await response.json();

    if (!response.ok) throw new Error(data.error || 'Login failed');

    currentToken = data.token;
    currentUser = data.user;
    currentBusiness = data.business;

    localStorage.setItem('token', currentToken);
    localStorage.setItem('user', JSON.stringify(currentUser));
    if (currentBusiness) localStorage.setItem('business', JSON.stringify(currentBusiness));

    showToast('success', 'Logged in successfully');
    initCommandShell();
  } catch (error) {
    showToast('error', error.message);
  }
}

async function handleRegisterOwner(e) {
  e.preventDefault();
  const form = document.getElementById('register-owner-form');
  const formData = new FormData();

  formData.append('invite_code', document.getElementById('owner-invite-code').value);
  formData.append('full_name', document.getElementById('owner-fullname').value);
  formData.append('email', document.getElementById('owner-email').value);
  formData.append('password', document.getElementById('owner-password').value);
  formData.append('business_name', document.getElementById('owner-business-name').value);
  formData.append('industry', document.getElementById('owner-industry').value);
  formData.append('location', document.getElementById('owner-location').value);
  formData.append('employee_count', document.getElementById('owner-employee-count').value);
  formData.append('description', document.getElementById('owner-description').value);
  
  const fileField = document.getElementById('owner-document');
  if (fileField.files.length > 0) {
    formData.append('document', fileField.files[0]);
  }

  try {
    const response = await fetch(`${API_URL}/api/auth/register-owner`, {
      method: 'POST',
      body: formData
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Partnership registration failed');

    showToast('success', 'Application submitted! Awaiting administrator approval.');
    form.reset();
    switchAuthTab('login');
  } catch (error) {
    showToast('error', error.message);
  }
}

async function handleRegisterGeneral(e) {
  e.preventDefault();
  const form = document.getElementById('register-general-form');
  const full_name = document.getElementById('gen-fullname').value;
  const email = document.getElementById('gen-email').value;
  const password = document.getElementById('gen-password').value;
  const role = document.getElementById('gen-role').value;
  const invite_code = document.getElementById('gen-invite-code').value.trim();

  try {
    const response = await fetch(`${API_URL}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ full_name, email, password, role, invite_code })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Registration failed');

    const msg = (invite_code || role !== 'Mentorship Members')
      ? 'Account created! You can now log in.'
      : 'Mentorship Account created. Awaiting admin approval to request sessions.';
    showToast('success', msg);
    form.reset();
    switchAuthTab('login');
  } catch (error) {
    showToast('error', error.message);
  }
}

function handleLogout() {
  currentToken = null;
  currentUser = null;
  currentBusiness = null;
  localStorage.clear();
  showToast('success', 'Logged out successfully');
  
  document.getElementById('command-shell').classList.add('hidden');
  if (isApp) {
    showAuthPanel();
  } else {
    document.getElementById('landing-page-container').classList.remove('hidden');
    hideAuthPanel();
  }
}

// Fetch headers helper
function getHeaders() {
  return {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${currentToken}`
  };
}

// --- DATA FETCHING & DYNAMIC RENDERING ---

async function fetchTabData(tabId) {
  if (tabId === 'dashboard') {
    loadDashboardHome();
  } else if (tabId === 'admin-businesses') {
    loadAdminBusinesses();
  } else if (tabId === 'admin-content') {
    loadAdminContentPipeline();
  } else if (tabId === 'admin-meetings') {
    loadAdminMeetings();
  } else if (tabId === 'admin-mentorship') {
    loadAdminMentorshipBoard();
  } else if (tabId === 'admin-invites') {
    loadAdminInvitations();
  } else if (tabId === 'admin-audit') {
    loadAdminAuditDesk();
  } else if (tabId === 'owner-profile') {
    loadOwnerProfile();
  } else if (tabId === 'owner-reports') {
    loadOwnerProgressLogs();
  } else if (tabId === 'owner-content') {
    loadOwnerContentDesk();
  } else if (tabId === 'owner-invoices') {
    loadOwnerInvoices();
  } else if (tabId === 'owner-meetings') {
    loadOwnerMeetings();
  } else if (tabId === 'owner-orders') {
    loadOwnerOrdersDesk();
  } else if (tabId === 'editor-dashboard') {
    loadEditorDashboard();
  } else if (tabId === 'smm-dashboard') {
    loadSmmDashboard();
  } else if (tabId === 'mentee-workspace') {
    loadMenteeWorkspace();
  } else if (tabId === 'boss-logs') {
    loadBossAuditLogs();
  } else if (tabId === 'team-chat') {
    loadChatContacts();
  } else if (tabId === 'fsdev-dashboard') {
    loadFsDevDashboard();
  } else if (tabId === 'fsdev-tasks') {
    // Task manager is a form, no dynamic loading needed
  } else if (tabId === 'webdev-dashboard') {
    loadWebDevDashboard();
  } else if (tabId === 'webdev-tasks') {
    // Task manager is a form, no dynamic loading needed
  } else if (tabId === 'aieng-dashboard') {
    loadAiEngDashboard();
  } else if (tabId === 'aieng-tasks') {
    // Task manager is a form, no dynamic loading needed
  } else if (tabId === 'admin-meeting-tasks') {
    loadAdminMeetingTasks();
  } else if (tabId === 'owner-meeting-tasks') {
    loadOwnerMeetingTasks();
    loadOwnerMeetingParticipants();
  } else if (tabId === 'editor-meetings') {
    loadEmployeeMeetings('editor-my-meetings-list');
  } else if (tabId === 'smm-meetings') {
    loadEmployeeMeetings('smm-my-meetings-list');
  } else if (tabId === 'mentee-meetings') {
    loadEmployeeMeetings('mentee-my-meetings-list');
  } else if (tabId === 'owner-projects') {
    loadOwnerProjects();
  } else if (tabId === 'assigned-projects') {
    loadAssignedProjects();
  } else if (tabId === 'admin-projects') {
    loadAdminProjects();
  } else if (tabId === 'workspaces') {
    loadWorkspaces();
  }
}

// 1. Dashboard Home Loader
async function loadDashboardHome() {
  const statsGrid = document.getElementById('dashboard-stats-grid');
  statsGrid.innerHTML = '<p>Loading metrics...</p>';

  if (['Super Admin', 'Admin Team'].includes(currentUser.role)) {
    try {
      const response = await fetch(`${API_URL}/api/admin/dashboard`, { headers: getHeaders() });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);

      // Render stats cards
      statsGrid.innerHTML = `
        <div class="stat-card">
          <div class="stat-icon" style="color:var(--accent-purple);">🏢</div>
          <div class="stat-info">
            <span class="stat-value">${data.stats.total_businesses}</span>
            <span class="stat-label">Total Portfolios</span>
          </div>
        </div>
        <div class="stat-card">
          <div class="stat-icon" style="color:#ff9f43;">⏳</div>
          <div class="stat-info">
            <span class="stat-value">${data.stats.pending_approvals}</span>
            <span class="stat-label">Pending Partners</span>
          </div>
        </div>
        <div class="stat-card">
          <div class="stat-icon" style="color:var(--accent-cyan);">🎬</div>
          <div class="stat-info">
            <span class="stat-value">${data.stats.workflow_active_tasks}</span>
            <span class="stat-label">Active Media Tasks</span>
          </div>
        </div>
        <div class="stat-card">
          <div class="stat-icon" style="color:#2ed573;">💵</div>
          <div class="stat-info">
            <span class="stat-value">$${data.stats.total_billing}</span>
            <span class="stat-label">Total Billing Paid</span>
          </div>
        </div>
      `;

      // Render content table
      const contentTableBody = document.querySelector('#dashboard-recent-content-table tbody');
      if (data.content_workflows.length === 0) {
        contentTableBody.innerHTML = '<tr><td colspan="3" class="text-center">No active content workflows.</td></tr>';
      } else {
        contentTableBody.innerHTML = data.content_workflows.slice(-5).map(item => `
          <tr>
            <td>${item.business_name}</td>
            <td>${item.content_idea.slice(0, 40)}...</td>
            <td><span class="badge badge-pending">${item.status}</span></td>
          </tr>
        `).join('');
      }

      // Render meetings list
      const meetingsList = document.getElementById('dashboard-meetings-list');
      if (data.meetings.length === 0) {
        meetingsList.innerHTML = '<p class="text-center" style="color:var(--text-muted);">No upcoming meetings.</p>';
      } else {
        meetingsList.innerHTML = data.meetings.slice(0, 3).map(meet => `
          <div class="timeline-item">
            <div class="timeline-title">${meet.title}</div>
            <div class="timeline-date">Business: ${meet.business_name} | ${new Date(meet.date_time).toLocaleString()}</div>
          </div>
        `).join('');
      }
    } catch (err) {
      showToast('error', 'Error loading admin stats');
    }
  } else {
    // Normal members and role users
    statsGrid.innerHTML = `
      <div class="stat-card">
        <div class="stat-icon">👤</div>
        <div class="stat-info">
          <span class="stat-value">${currentUser.role.split(' ')[0]}</span>
          <span class="stat-label">Active Level</span>
        </div>
      </div>
      <div class="stat-card">
        <div class="stat-icon">🔔</div>
        <div class="stat-info">
          <span class="stat-value" id="dash-notify-val">0</span>
          <span class="stat-label">New Messages</span>
        </div>
      </div>
    `;
    // Update local notifications count
    const notifyRes = await fetch(`${API_URL}/api/notifications`, { headers: getHeaders() });
    if (notifyRes.ok) {
      const list = await notifyRes.json();
      document.getElementById('dash-notify-val').innerText = list.filter(n => !n.is_read).length;
    }
  }
}

// 2. Admin Business Manager
async function loadAdminBusinesses() {
  try {
    const res = await fetch(`${API_URL}/api/businesses`, { headers: getHeaders() });
    const businesses = await res.json();
    if (!res.ok) throw new Error(businesses.error);

    const tbody = document.querySelector('#admin-businesses-table tbody');
    if (businesses.length === 0) {
      tbody.innerHTML = '<tr><td colspan="8" class="text-center">No businesses registered.</td></tr>';
      return;
    }

    tbody.innerHTML = businesses.map(b => `
      <tr>
        <td><strong>${b.business_name}</strong></td>
        <td>${b.industry}</td>
        <td>${b.location}</td>
        <td>${b.employee_count}</td>
        <td>${b.owner_name}</td>
        <td>
          ${b.contracts && b.contracts.length > 0
            ? b.contracts.map((c, i) => `<a href="${API_URL}${c}" target="_blank" class="doc-download-link" style="font-size:12px;">⬇️ Contract</a>`).join(', ')
            : '<span style="color:var(--text-muted);">None</span>'}
        </td>
        <td><span class="badge ${b.status === 'approved' ? 'badge-success' : 'badge-pending'}">${b.status}</span></td>
        <td>
          ${b.status === 'pending' 
            ? `<button class="btn-primary" onclick="approveBusiness('${b.id}')" style="padding:5px 10px; font-size:12px;">Approve</button>` 
            : '<span style="color:green;">Authorized</span>'}
        </td>
      </tr>
    `).join('');
  } catch (err) {
    showToast('error', err.message);
  }
}

async function approveBusiness(id) {
  try {
    const res = await fetch(`${API_URL}/api/businesses/${id}/approve`, {
      method: 'POST',
      headers: getHeaders()
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);

    showToast('success', 'Business approved successfully');
    loadAdminBusinesses();
  } catch (err) {
    showToast('error', err.message);
  }
}

// 3. Admin Content Pipeline Kanban
async function loadAdminContentPipeline() {
  try {
    const res = await fetch(`${API_URL}/api/content`, { headers: getHeaders() });
    const items = await res.json();
    if (!res.ok) throw new Error(items.error);

    // Filter team users for assign selections
    const usersRes = await fetch(`${API_URL}/api/users`, { headers: getHeaders() });
    const usersData = await usersRes.json();
    const users = Array.isArray(usersData) ? usersData : [];
    const editors = users.filter(u => u.role === 'Video Editors');
    const smms = users.filter(u => u.role === 'Social Media Managers');

    // Categorize
    const listRaw = items.filter(x => x.status === 'pending_admin_review');
    const listEditing = items.filter(x => x.status === 'assigned_editor');
    const listReview = items.filter(x => x.status === 'editor_submitted');
    const listPublish = items.filter(x => x.status === 'approved' || x.status === 'assigned_sm_manager');
    const listLive = items.filter(x => x.status === 'published');

    document.getElementById('count-raw').innerText = listRaw.length;
    document.getElementById('count-editing').innerText = listEditing.length;
    document.getElementById('count-review').innerText = listReview.length;
    document.getElementById('count-publish').innerText = listPublish.length;
    document.getElementById('count-live').innerText = listLive.length;

    // Render cards
    renderKanbanColumn('kanban-raw-list', listRaw, card => `
      <div class="kanban-card">
        <div class="kanban-card-title">${card.business_name}</div>
        <div class="kanban-card-meta">Idea: ${card.content_idea}</div>
        <div class="kanban-card-meta">Instructions: ${card.instructions}</div>
        ${card.raw_video_url ? `<a href="${API_URL}${card.raw_video_url}" target="_blank" class="doc-download-link" style="margin-top:5px;">⬇️ Raw Video</a>` : ''}
        <div style="margin-top:10px;">
          <label style="font-size:11px; margin-bottom:4px;">Assign Video Editor</label>
          <select class="editor-select-${card.id}" style="padding:6px; font-size:12px;">
            ${editors.map(e => `<option value="${e.id}">${e.full_name}</option>`).join('')}
          </select>
          <input type="date" class="editor-deadline-${card.id}" style="padding:6px; font-size:12px; margin-top:5px;" required>
          <button class="btn-primary kanban-card-action" onclick="assignEditor('${card.id}')">Submit Assignment</button>
        </div>
      </div>
    `);

    renderKanbanColumn('kanban-editing-list', listEditing, card => `
      <div class="kanban-card">
        <div class="kanban-card-title">${card.business_name}</div>
        <div class="kanban-card-meta">Idea: ${card.content_idea}</div>
        <div class="kanban-card-meta">Deadline: ${card.deadline}</div>
        <div class="badge badge-pending" style="align-self: flex-start; margin-top:5px;">Editor Working</div>
      </div>
    `);

    renderKanbanColumn('kanban-review-list', listReview, card => `
      <div class="kanban-card">
        <div class="kanban-card-title">${card.business_name}</div>
        <div class="kanban-card-meta">Idea: ${card.content_idea}</div>
        <div class="kanban-card-meta">Editor Notes: ${card.editor_notes || 'N/A'}</div>
        <a href="${card.edited_video_url}" target="_blank" class="doc-download-link" style="margin-top:5px;">🎥 View Deliverable</a>
        <div class="form-row" style="margin-top:10px;">
          <button class="btn-primary" style="flex:1; padding:6px; font-size:12px; background:green;" onclick="reviewContent('${card.id}', 'approve')">Approve</button>
          <button class="btn-secondary" style="flex:1; padding:6px; font-size:12px; border-color:red; color:red;" onclick="reviewContent('${card.id}', 'revision')">Revise</button>
        </div>
      </div>
    `);

    renderKanbanColumn('kanban-publish-list', listPublish, card => `
      <div class="kanban-card">
        <div class="kanban-card-title">${card.business_name}</div>
        <div class="kanban-card-meta">Idea: ${card.content_idea}</div>
        <a href="${card.edited_video_url}" target="_blank" class="doc-download-link" style="margin-top:5px;">🎥 Approved Video</a>
        ${card.status === 'assigned_sm_manager' 
          ? `<div class="badge badge-approved" style="align-self:flex-start; margin-top:5px;">Assigned to SMM</div>`
          : `<div style="margin-top:10px;">
              <label style="font-size:11px; margin-bottom:4px;">Assign Social Manager</label>
              <select class="smm-select-${card.id}" style="padding:6px; font-size:12px; margin-bottom:5px;">
                ${smms.map(s => `<option value="${s.id}">${s.full_name}</option>`).join('')}
              </select>
              <button class="btn-primary kanban-card-action" onclick="assignSmm('${card.id}')">Submit SMM Task</button>
            </div>`}
      </div>
    `);

    renderKanbanColumn('kanban-live-list', listLive, card => `
      <div class="kanban-card">
        <div class="kanban-card-title">${card.business_name}</div>
        <div class="kanban-card-meta">Idea: ${card.content_idea}</div>
        <div class="kanban-card-meta"><strong>Published Proofs:</strong></div>
        <div style="font-size:11px; display:flex; flex-direction:column; gap:4px;">
          ${card.live_post_urls.tiktok ? `<a href="${card.live_post_urls.tiktok}" target="_blank" style="color:var(--accent-cyan);">TikTok Link</a>` : ''}
          ${card.live_post_urls.instagram ? `<a href="${card.live_post_urls.instagram}" target="_blank" style="color:var(--accent-cyan);">Instagram Link</a>` : ''}
          ${card.live_post_urls.facebook ? `<a href="${card.live_post_urls.facebook}" target="_blank" style="color:var(--accent-cyan);">Facebook Link</a>` : ''}
          ${card.live_post_urls.shorts ? `<a href="${card.live_post_urls.shorts}" target="_blank" style="color:var(--accent-cyan);">YouTube Shorts Link</a>` : ''}
        </div>
      </div>
    `);
  } catch (err) {
    showToast('error', err.message);
  }
}

function renderKanbanColumn(elementId, items, templateFn) {
  const container = document.getElementById(elementId);
  if (items.length === 0) {
    container.innerHTML = '<p class="text-center" style="color:var(--text-muted); font-size:12px; margin-top:20px;">Column is empty</p>';
    return;
  }
  container.innerHTML = items.map(templateFn).join('');
}

async function assignEditor(id) {
  const editor_id = document.querySelector(`.editor-select-${id}`).value;
  const deadline = document.querySelector(`.editor-deadline-${id}`).value;
  if (!deadline) return showToast('error', 'Select a production deadline');

  try {
    const res = await fetch(`${API_URL}/api/content/${id}/assign-editor`, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify({ editor_id, deadline })
    });
    if (!res.ok) throw new Error('Failed assignment');
    showToast('success', 'Assigned successfully to editor');
    loadAdminContentPipeline();
  } catch (err) {
    showToast('error', err.message);
  }
}

async function reviewContent(id, action) {
  const notes = prompt(action === 'approve' ? 'Optional approval notes:' : 'Enter revision feedback request:');
  if (action === 'revision' && !notes) return showToast('error', 'Feedback is required for revisions');

  try {
    const res = await fetch(`${API_URL}/api/content/${id}/admin-review`, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify({ action, notes })
    });
    if (!res.ok) throw new Error('Failed to save review');
    showToast('success', action === 'approve' ? 'Content approved!' : 'Revision requested');
    loadAdminContentPipeline();
  } catch (err) {
    showToast('error', err.message);
  }
}

async function assignSmm(id) {
  const sm_manager_id = document.querySelector(`.smm-select-${id}`).value;
  try {
    const res = await fetch(`${API_URL}/api/content/${id}/assign-sm`, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify({ sm_manager_id })
    });
    if (!res.ok) throw new Error('Failed assignment');
    showToast('success', 'Assigned to SMM dispatcher');
    loadAdminContentPipeline();
  } catch (err) {
    showToast('error', err.message);
  }
}

// 4. Admin Meetings Scheduler
async function loadAdminMeetings() {
  try {
    const res = await fetch(`${API_URL}/api/meetings`, { headers: getHeaders() });
    const list = await res.json();
    if (!res.ok) throw new Error(list.error);

    // 1. Render Requests Table
    const requestsTableBody = document.querySelector('#admin-meetings-requests-table tbody');
    const pendingMeetings = list.filter(m => m.status === 'pending_approval');
    
    if (pendingMeetings.length === 0) {
      requestsTableBody.innerHTML = '<tr><td colspan="5" class="text-center">No pending meeting requests.</td></tr>';
    } else {
      requestsTableBody.innerHTML = pendingMeetings.map(m => `
        <tr>
          <td><strong>${m.business_name}</strong></td>
          <td>${m.title}</td>
          <td>${new Date(m.date_time).toLocaleString()}</td>
          <td><span class="badge badge-pending">Pending Approval</span></td>
          <td>
            <div style="display:flex; gap:6px;">
              <button class="btn-primary" style="padding:4px 8px; font-size:11px; background:green; border:none; cursor:pointer;" onclick="approveMeeting('${m.id}')">Approve</button>
              <button class="btn-secondary" style="padding:4px 8px; font-size:11px; border-color:red; color:red; cursor:pointer;" onclick="rejectMeeting('${m.id}')">Reject</button>
              <button class="btn-secondary" style="padding:4px 8px; font-size:11px; cursor:pointer;" onclick="rescheduleMeeting('${m.id}', '${m.date_time}')">Reschedule</button>
            </div>
          </td>
        </tr>
      `).join('');
    }

    // 2. Render Scheduled Meetings Timeline
    const timeline = document.getElementById('admin-meetings-timeline');
    const activeMeetings = list.filter(m => m.status === 'scheduled' || m.status === 'completed');

    if (activeMeetings.length === 0) {
      timeline.innerHTML = '<p style="color:var(--text-muted);">No scheduled meetings found.</p>';
      return;
    }

    timeline.innerHTML = activeMeetings.map(meet => `
      <div class="timeline-item" onclick="selectMeetingForAdminUpdate('${meet.id}')" id="admin-meet-${meet.id}">
        <div style="display:flex; justify-content:space-between; align-items:flex-start; width:100%;">
          <div>
            <div class="timeline-title">${meet.title}</div>
            <div class="timeline-date">
              Business: <strong>${meet.business_name}</strong> | Status: ${meet.status.toUpperCase()}
              <br>Scheduled for: ${new Date(meet.date_time).toLocaleString()}
              ${meet.participant_names && meet.participant_names.length > 0 ? `<br>👥 Participants: ${meet.participant_names.join(', ')}` : ''}
            </div>
          </div>
          ${meet.status === 'scheduled' 
            ? `<button class="btn-primary" style="padding:5px 10px; font-size:11px; margin-left:10px; background:#704df4; border:none; cursor:pointer;" onclick="event.stopPropagation(); joinMeetingRoom('${meet.id}')">🎥 Join Room</button>` 
            : ''}
        </div>
      </div>
    `).join('');
  } catch (err) {
    showToast('error', err.message);
  }
}

async function selectMeetingForAdminUpdate(id) {
  document.querySelectorAll('.timeline-item').forEach(x => x.classList.remove('active'));
  const el = document.getElementById(`admin-meet-${id}`);
  if (el) el.classList.add('active');

  try {
    const res = await fetch(`${API_URL}/api/meetings`, { headers: getHeaders() });
    const list = await res.json();
    const meet = list.find(m => m.id === id);

    document.getElementById('update-meeting-id').value = meet.id;
    document.getElementById('update-meeting-title-readonly').value = meet.title;
    document.getElementById('update-meeting-notes').value = meet.notes || '';
    document.getElementById('update-meeting-followups').value = meet.follow_ups || '';

    // Fetch related users to check attendance
    const usersRes = await fetch(`${API_URL}/api/users`, { headers: getHeaders() });
    const allUsersData = await usersRes.json();
    const allUsers = Array.isArray(allUsersData) ? allUsersData : [];
    
    const container = document.getElementById('update-meeting-attendance-list');
    container.innerHTML = allUsers.map(user => `
      <div class="attendance-user-row">
        <input type="checkbox" class="attendance-check" value="${user.id}" ${meet.attendance.includes(user.id) ? 'checked' : ''}>
        <label>${user.full_name} (${user.role})</label>
      </div>
    `).join('');
  } catch (err) {
    showToast('error', 'Error loading meeting details');
  }
}

async function handleSaveMeetingDetails(e) {
  e.preventDefault();
  const id = document.getElementById('update-meeting-id').value;
  if (!id) return showToast('error', 'Select a meeting from the list first');

  const notes = document.getElementById('update-meeting-notes').value;
  const follow_ups = document.getElementById('update-meeting-followups').value;

  const attendance = [];
  document.querySelectorAll('.attendance-check').forEach(chk => {
    if (chk.checked) attendance.push(chk.value);
  });

  try {
    const res = await fetch(`${API_URL}/api/meetings/${id}`, {
      method: 'PUT',
      headers: getHeaders(),
      body: JSON.stringify({ notes, follow_ups, attendance, status: 'completed' })
    });
    if (!res.ok) throw new Error('Update failed');

    showToast('success', 'Meeting notes and attendance logged');
    loadAdminMeetings();
  } catch (err) {
    showToast('error', err.message);
  }
}

async function openScheduleMeetingModal() {
  const modal = document.getElementById('schedule-meeting-modal');
  modal.classList.remove('hidden');

  // Fill businesses dropdown
  const res = await fetch(`${API_URL}/api/businesses`, { headers: getHeaders() });
  const list = await res.json();
  const select = document.getElementById('meet-biz-id');
  select.innerHTML = '<option value="">Global / Platform Briefing</option>' + 
    list.map(b => `<option value="${b.id}">${b.business_name}</option>`).join('');

  // Fill participants checkboxes
  const usersRes = await fetch(`${API_URL}/api/users`, { headers: getHeaders() });
  const usersData = await usersRes.json();
  const users = Array.isArray(usersData) ? usersData : [];
  const container = document.getElementById('meet-participants-checkboxes');
  container.innerHTML = users.map(u => `
    <div style="display:flex; align-items:center; gap:8px; padding:6px 0; border-bottom:1px solid rgba(255,255,255,0.05);">
      <input type="checkbox" class="meet-participant-check" value="${u.id}" id="mp-${u.id}">
      <label for="mp-${u.id}" style="font-size:13px;">${u.full_name} (${u.role})</label>
    </div>
  `).join('');
}

function closeScheduleMeetingModal() {
  document.getElementById('schedule-meeting-modal').classList.add('hidden');
}

async function handleAdminScheduleMeeting(e) {
  e.preventDefault();
  const business_id = document.getElementById('meet-biz-id').value;
  const title = document.getElementById('meet-title').value;
  const date_time = document.getElementById('meet-datetime').value;
  const participants = [];
  document.querySelectorAll('.meet-participant-check:checked').forEach(cb => participants.push(cb.value));

  try {
    const res = await fetch(`${API_URL}/api/meetings`, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify({ business_id, title, date_time, participants })
    });
    if (!res.ok) throw new Error('Schedule request failed');

    showToast('success', `Meeting scheduled with ${participants.length} participant(s)`);
    closeScheduleMeetingModal();
    loadAdminMeetings();
  } catch (err) {
    showToast('error', err.message);
  }
}

// 5. Admin Mentorship Panel
async function loadAdminMentorshipBoard() {
  try {
    const res = await fetch(`${API_URL}/api/mentorship/requests`, { headers: getHeaders() });
    const requests = await res.json();
    if (!res.ok) throw new Error(requests.error);

    const requestsTable = document.querySelector('#admin-mentorship-requests-table tbody');
    const pendingList = requests.filter(r => r.status === 'pending');
    
    if (pendingList.length === 0) {
      requestsTable.innerHTML = '<tr><td colspan="6" class="text-center">No pending requests.</td></tr>';
    } else {
      requestsTable.innerHTML = pendingList.map(r => `
        <tr>
          <td><strong>${r.member_name}</strong></td>
          <td>${r.challenges}</td>
          <td>${r.topics}</td>
          <td>${r.requested_date}</td>
          <td><span class="badge badge-pending">${r.status}</span></td>
          <td>
            <input type="datetime-local" class="schedule-date-${r.id}" style="padding:6px; font-size:12px; margin-bottom:5px;">
            <button class="btn-primary" style="padding:6px 12px; font-size:12px;" onclick="approveMentorship('${r.id}')">Approve & Schedule</button>
          </td>
        </tr>
      `).join('');
    }

    // Active session selection
    const approvedList = requests.filter(r => r.status === 'approved');
    const sessionsPanel = document.getElementById('admin-active-mentorship-sessions');
    if (approvedList.length === 0) {
      sessionsPanel.innerHTML = '<p class="text-center" style="color:var(--text-muted);">No active approved sessions</p>';
    } else {
      sessionsPanel.innerHTML = approvedList.map(s => `
        <div class="selection-card" onclick="selectMentorshipSession('${s.id}')" id="mentor-session-${s.id}">
          <strong>${s.member_name}</strong>
          <div style="font-size:11px; margin-top:4px;">Date: ${new Date(s.meeting_date).toLocaleString()}</div>
        </div>
      `).join('');
    }
  } catch (err) {
    showToast('error', err.message);
  }
}

async function approveMentorship(id) {
  const meeting_date = document.querySelector(`.schedule-date-${id}`).value;
  if (!meeting_date) return showToast('error', 'Please input meeting datetime');

  try {
    const res = await fetch(`${API_URL}/api/mentorship/requests/${id}/approve`, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify({ meeting_date })
    });
    if (!res.ok) throw new Error('Approval failed');

    showToast('success', 'Mentorship session scheduled');
    loadAdminMentorshipBoard();
  } catch (err) {
    showToast('error', err.message);
  }
}

async function selectMentorshipSession(id) {
  document.querySelectorAll('.selection-card').forEach(x => x.classList.remove('selected'));
  const card = document.getElementById(`mentor-session-${id}`);
  if (card) card.classList.add('selected');

  try {
    const res = await fetch(`${API_URL}/api/mentorship/requests`, { headers: getHeaders() });
    const requests = await res.json();
    const session = requests.find(r => r.id === id);

    document.getElementById('mentorship-session-id').value = session.id;
    document.getElementById('mentorship-mentee-name').value = session.member_name;
    document.getElementById('mentorship-notes').value = session.notes || '';
    document.getElementById('mentorship-recommendations').value = session.recommendations || '';
    document.getElementById('mentorship-actionplan').value = session.action_plans ? session.action_plans.join('\n') : '';
  } catch (err) {
    showToast('error', 'Error loading session details');
  }
}

async function handleSaveMentorshipSession(e) {
  e.preventDefault();
  const id = document.getElementById('mentorship-session-id').value;
  if (!id) return showToast('error', 'Select a mentorship session from the list');

  const notes = document.getElementById('mentorship-notes').value;
  const recommendations = document.getElementById('mentorship-recommendations').value;
  const actionplanRaw = document.getElementById('mentorship-actionplan').value;
  const action_plans = actionplanRaw.split('\n').filter(line => line.trim().length > 0);

  try {
    const res = await fetch(`${API_URL}/api/mentorship/requests/${id}/session`, {
      method: 'PUT',
      headers: getHeaders(),
      body: JSON.stringify({ notes, recommendations, action_plans })
    });
    if (!res.ok) throw new Error('Update failed');

    showToast('success', 'Mentorship session documented successfully');
    loadAdminMentorshipBoard();
  } catch (err) {
    showToast('error', err.message);
  }
}

// Global cache for modal viewing
let currentInvitations = [];

function toggleBizField() {
  const roleSelect = document.getElementById('invite-role');
  const bizGroup = document.getElementById('invite-biz-group');
  const bizName = document.getElementById('invite-biz-name');
  if (roleSelect && bizGroup && bizName) {
    if (roleSelect.value === 'Business Owners') {
      bizGroup.style.display = 'block';
      bizName.required = true;
    } else {
      bizGroup.style.display = 'none';
      bizName.required = false;
      bizName.value = '';
    }
  }
}

// 6. Admin Invitations Loader
async function loadAdminInvitations() {
  try {
    // Ensure correct fields display/hide initially
    toggleBizField();

    const res = await fetch(`${API_URL}/api/invitations`, { headers: getHeaders() });
    const list = await res.json();
    if (!res.ok) throw new Error(list.error);

    currentInvitations = list;

    const tbody = document.querySelector('#admin-invitations-list-table tbody');
    if (list.length === 0) {
      tbody.innerHTML = '<tr><td colspan="7" class="text-center">No invitation links generated.</td></tr>';
      return;
    }

    tbody.innerHTML = list.map(inv => {
      const emailText = inv.email || '<span style="color:var(--text-muted);">N/A (Legacy link)</span>';
      const roleText = inv.role || 'Business Owners';
      const bizText = inv.business_name || 'N/A';
      
      const contractHtml = inv.contract_path 
        ? `<a href="${API_URL}${inv.contract_path}" target="_blank" class="doc-download-link" style="padding: 2px 6px; font-size: 11px; display: inline-block;">⬇️ Download PDF</a>`
        : '<span style="color:var(--text-muted);">None</span>';
        
      const actionHtml = inv.email_body
        ? `<button class="btn-secondary" onclick="viewInvitationDetails('${inv.id}')" style="padding:4px 8px; font-size:11px; margin: 0; line-height: 1;">View Email</button>`
        : '<span style="color:var(--text-muted);">N/A</span>';

      return `
        <tr>
          <td>${emailText}</td>
          <td><span class="badge badge-active" style="background-color: rgba(255,255,255,0.05); color: var(--primary-color);">${roleText}</span></td>
          <td><strong>${bizText}</strong></td>
          <td><code>${inv.code}</code></td>
          <td><span class="badge ${inv.is_used ? 'badge-success' : 'badge-active'}">${inv.is_used ? 'Used' : 'Active'}</span></td>
          <td>${contractHtml}</td>
          <td>${actionHtml}</td>
        </tr>
      `;
    }).join('');
  } catch (err) {
    showToast('error', err.message);
  }
}

async function handleGenerateInvite(e) {
  e.preventDefault();
  const business_name = document.getElementById('invite-biz-name').value;
  const email = document.getElementById('invite-email').value;
  const role = document.getElementById('invite-role').value;
  const contractField = document.getElementById('invite-contract');

  const formData = new FormData();
  formData.append('business_name', business_name);
  formData.append('email', email);
  formData.append('role', role);
  if (contractField && contractField.files.length > 0) {
    formData.append('contract', contractField.files[0]);
  }

  showToast('info', 'Analyzing contract & drafting invitation email... Please wait.');

  try {
    const res = await fetch(`${API_URL}/api/invitations/create`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${currentToken}`
      },
      body: formData
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Error sending invitation');

    showToast('success', 'Invitation email sent successfully!');
    
    // Reset form
    document.getElementById('invite-email').value = '';
    document.getElementById('invite-biz-name').value = '';
    if (contractField) contractField.value = '';
    
    loadAdminInvitations();
  } catch (err) {
    showToast('error', err.message);
  }
}

function viewInvitationDetails(id) {
  const inv = currentInvitations.find(x => x.id === id);
  if (!inv) return;

  document.getElementById('modal-inv-email').innerText = inv.email || 'N/A';
  document.getElementById('modal-inv-role').innerText = inv.role || 'Business Owners';
  
  const bizRow = document.getElementById('modal-inv-biz-row');
  const bizVal = document.getElementById('modal-inv-biz');
  if (inv.business_name && inv.business_name !== 'N/A') {
    bizRow.style.display = 'block';
    bizVal.innerText = inv.business_name;
  } else {
    bizRow.style.display = 'none';
  }

  document.getElementById('modal-inv-code').innerText = inv.code;
  document.getElementById('modal-inv-email-body').innerText = inv.email_body || 'No email body drafted.';
  
  document.getElementById('invitation-details-modal').classList.remove('hidden');
}

function closeInvitationDetailsModal() {
  document.getElementById('invitation-details-modal').classList.add('hidden');
}

// 7. Owner Profile Loader
async function loadOwnerProfile() {
  try {
    const res = await fetch(`${API_URL}/api/businesses/my`, { headers: getHeaders() });
    const bus = await res.json();
    if (!res.ok) throw new Error(bus.error);

    currentBusiness = bus;
    localStorage.setItem('business', JSON.stringify(bus));

    document.getElementById('prof-biz-name').value = bus.business_name;
    document.getElementById('prof-biz-industry').value = bus.industry;
    document.getElementById('prof-biz-location').value = bus.location;
    document.getElementById('prof-biz-employees').value = bus.employee_count;
    document.getElementById('prof-biz-description').value = bus.description;

    const docList = document.getElementById('owner-documents-list');
    if (bus.contracts && bus.contracts.length > 0) {
      docList.innerHTML = bus.contracts.map((c, i) => `
        <a href="${API_URL}${c}" target="_blank" class="doc-download-link mt-15">⬇️ Download Signed Agreement Document</a>
      `).join('');
    } else {
      docList.innerHTML = '<p style="color:var(--text-muted);">No agreement document uploaded.</p>';
    }

    // Render Analytics Chart
    renderBusinessAnalyticsChart(bus.revenue_insights);
  } catch (err) {
    showToast('error', err.message);
  }
}

function renderBusinessAnalyticsChart(insights) {
  if (!insights) return;
  const ctx = document.getElementById('businessAnalyticsChart').getContext('2d');
  
  if (chartsInstance) chartsInstance.destroy();

  chartsInstance = new Chart(ctx, {
    type: 'line',
    data: {
      labels: insights.map(i => i.month),
      datasets: [
        {
          label: 'Monthly Revenue ($)',
          data: insights.map(i => i.revenue),
          borderColor: '#704df4',
          backgroundColor: 'rgba(112, 77, 244, 0.1)',
          fill: true,
          tension: 0.4
        },
        {
          label: 'Monthly Profit ($)',
          data: insights.map(i => i.profit),
          borderColor: '#00d2ff',
          backgroundColor: 'rgba(0, 210, 255, 0.1)',
          fill: true,
          tension: 0.4
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        y: { grid: { color: 'rgba(255, 255, 255, 0.05)' }, ticks: { color: '#a4a9c6' } },
        x: { grid: { color: 'rgba(255, 255, 255, 0.05)' }, ticks: { color: '#a4a9c6' } }
      },
      plugins: {
        legend: { labels: { color: '#f1f2f6' } }
      }
    }
  });
}

async function handleUpdateBusinessProfile(e) {
  e.preventDefault();
  const business_name = document.getElementById('prof-biz-name').value;
  const industry = document.getElementById('prof-biz-industry').value;
  const location = document.getElementById('prof-biz-location').value;
  const employee_count = parseInt(document.getElementById('prof-biz-employees').value);
  const description = document.getElementById('prof-biz-description').value;

  try {
    const res = await fetch(`${API_URL}/api/businesses/my`, {
      method: 'PUT',
      headers: getHeaders(),
      body: JSON.stringify({ business_name, industry, location, employee_count, description })
    });
    if (!res.ok) throw new Error('Update failed');
    showToast('success', 'Business profile updated successfully');
    loadOwnerProfile();
  } catch (err) {
    showToast('error', err.message);
  }
}

// 8. Owner Progress Logs
async function loadOwnerProgressLogs() {
  try {
    const res = await fetch(`${API_URL}/api/reports`, { headers: getHeaders() });
    const list = await res.json();
    if (!res.ok) throw new Error(list.error);

    const timeline = document.getElementById('owner-reports-timeline');
    if (list.length === 0) {
      timeline.innerHTML = '<p style="color:var(--text-muted);">No reports submitted yet.</p>';
      return;
    }

    timeline.innerHTML = list.map(rep => `
      <div class="timeline-node">
        <div class="timeline-node-content">
          <strong>Daily Report (${rep.date})</strong>
          <div style="margin-top:8px; font-size:13px; display:flex; flex-direction:column; gap:6px;">
            <div><strong>Activities:</strong> ${rep.activities}</div>
            <div><strong>Active Projects:</strong> ${rep.active_projects}</div>
            <div><strong>Team Progress:</strong> ${rep.progress}</div>
            <div><strong>Challenges:</strong> ${rep.challenges}</div>
            <div><strong>Goals:</strong> ${rep.goals}</div>
          </div>
        </div>
      </div>
    `).join('');
  } catch (err) {
    showToast('error', err.message);
  }
}

async function handleSubmitDailyReport(e) {
  e.preventDefault();
  const activities = document.getElementById('rep-activities').value;
  const active_projects = document.getElementById('rep-active-projects').value;
  const progress = document.getElementById('rep-progress').value;
  const challenges = document.getElementById('rep-challenges').value;
  const goals = document.getElementById('rep-goals').value;
  const updates = document.getElementById('rep-updates').value;

  try {
    const res = await fetch(`${API_URL}/api/reports/daily`, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify({ activities, active_projects, progress, challenges, goals, updates })
    });
    if (!res.ok) throw new Error('Submission failed');

    showToast('success', 'Daily report submitted successfully');
    document.getElementById('daily-report-form').reset();
    loadOwnerProgressLogs();
  } catch (err) {
    showToast('error', err.message);
  }
}

// 9. Owner Content Desk Uploads
async function loadOwnerContentDesk() {
  try {
    const res = await fetch(`${API_URL}/api/content`, { headers: getHeaders() });
    const list = await res.json();
    if (!res.ok) throw new Error(list.error);

    const tbody = document.querySelector('#owner-content-status-table tbody');
    if (list.length === 0) {
      tbody.innerHTML = '<tr><td colspan="3" class="text-center">No creative content uploads yet.</td></tr>';
      return;
    }

    tbody.innerHTML = list.map(item => `
      <tr>
        <td><strong>${item.content_idea}</strong></td>
        <td><span class="badge ${item.status === 'published' ? 'badge-success' : 'badge-pending'}">${item.status.replace(/_/g, ' ')}</span></td>
        <td>
          ${item.status === 'published' 
            ? Object.entries(item.live_post_urls).map(([plat, url]) => `<a href="${url}" target="_blank" style="margin-right:8px; color:var(--accent-cyan); text-transform:capitalize;">${plat}</a>`).join('')
            : '<span style="color:var(--text-muted);">Awaiting publishing</span>'}
        </td>
      </tr>
    `).join('');
  } catch (err) {
    showToast('error', err.message);
  }
}

async function handleSubmitRawContent(e) {
  e.preventDefault();
  const form = document.getElementById('owner-content-form');
  const formData = new FormData();
  formData.append('content_idea', document.getElementById('content-idea').value);
  formData.append('instructions', document.getElementById('content-instructions').value);
  
  const fileField = document.getElementById('content-raw-videos');
  if (fileField && fileField.files.length > 0) {
    for (let i = 0; i < fileField.files.length; i++) {
      formData.append('raw_videos', fileField.files[i]);
    }
  } else {
    return showToast('error', 'Please select at least one raw video file.');
  }

  try {
    const res = await fetch(`${API_URL}/api/content/submit`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${currentToken}`
      },
      body: formData
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);

    showToast('success', 'Creative content files uploaded successfully');
    form.reset();
    loadOwnerContentDesk();
  } catch (err) {
    showToast('error', err.message);
  }
}

// 10. Owner Invoice System
async function loadOwnerInvoices() {
  try {
    const res = await fetch(`${API_URL}/api/invoices`, { headers: getHeaders() });
    const list = await res.json();
    if (!res.ok) throw new Error(list.error);

    const tbody = document.querySelector('#owner-invoices-table tbody');
    if (list.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6" class="text-center">No client invoices created.</td></tr>';
      return;
    }

    tbody.innerHTML = list.map(inv => `
      <tr>
        <td><strong>${inv.invoice_number}</strong></td>
        <td>${inv.client_name}</td>
        <td>${inv.due_date}</td>
        <td>$${parseFloat(inv.total).toFixed(2)}</td>
        <td>
          <select onchange="updateInvoiceStatus('${inv.id}', this.value)" style="padding:4px; font-size:12px;">
            <option value="unpaid" ${inv.status === 'unpaid' ? 'selected' : ''}>Unpaid</option>
            <option value="paid" ${inv.status === 'paid' ? 'selected' : ''}>Paid</option>
          </select>
        </td>
        <td>
          <a href="${API_URL}/api/invoices/${inv.id}/print" target="_blank" class="doc-download-link">⎙ Print/PDF</a>
        </td>
      </tr>
    `).join('');
  } catch (err) {
    showToast('error', err.message);
  }
}

async function updateInvoiceStatus(id, status) {
  try {
    const res = await fetch(`${API_URL}/api/invoices/${id}/status`, {
      method: 'PATCH',
      headers: getHeaders(),
      body: JSON.stringify({ status })
    });
    if (!res.ok) throw new Error('Status update failed');
    showToast('success', 'Invoice status updated');
    loadOwnerInvoices();
  } catch (err) {
    showToast('error', err.message);
  }
}

function openCreateInvoiceModal() {
  document.getElementById('invoice-modal').classList.remove('hidden');
}

function closeCreateInvoiceModal() {
  document.getElementById('invoice-modal').classList.add('hidden');
}

function addInvoiceItemRow() {
  const container = document.getElementById('invoice-items-builder');
  const row = document.createElement('div');
  row.className = 'form-row invoice-item-row';
  row.innerHTML = `
    <input type="text" placeholder="Item/Service Name" class="inv-item-name" required style="flex:3;">
    <input type="number" min="0" step="0.01" placeholder="Price" class="inv-item-price" required style="flex:1.5;">
    <input type="number" min="1" placeholder="Qty" class="inv-item-qty" required style="flex:1;">
  `;
  container.appendChild(row);
}

async function handleCreateInvoice(e) {
  e.preventDefault();
  const client_name = document.getElementById('inv-client-name').value;
  const client_email = document.getElementById('inv-client-email').value;
  const branding_title = document.getElementById('inv-branding').value;
  const due_date = document.getElementById('inv-due-date').value;

  const items = [];
  document.querySelectorAll('.invoice-item-row').forEach(row => {
    const name = row.querySelector('.inv-item-name').value;
    const price = parseFloat(row.querySelector('.inv-item-price').value);
    const quantity = parseInt(row.querySelector('.inv-item-qty').value);
    items.push({ name, price, quantity });
  });

  try {
    const res = await fetch(`${API_URL}/api/invoices`, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify({ client_name, client_email, branding_title, due_date, items })
    });
    if (!res.ok) throw new Error('Invoice generation failed');

    showToast('success', 'Invoice created successfully');
    closeCreateInvoiceModal();
    document.getElementById('invoice-creation-form').reset();
    // Reset builder rows to single
    document.getElementById('invoice-items-builder').innerHTML = `
      <div class="form-row invoice-item-row">
        <input type="text" placeholder="Item/Service Name" class="inv-item-name" required style="flex:3;">
        <input type="number" min="0" step="0.01" placeholder="Price" class="inv-item-price" required style="flex:1.5;">
        <input type="number" min="1" placeholder="Qty" class="inv-item-qty" required style="flex:1;">
      </div>
    `;
    loadOwnerInvoices();
  } catch (err) {
    showToast('error', err.message);
  }
}

// 11. Owner Meetings Briefings
async function loadOwnerMeetings() {
  try {
    const res = await fetch(`${API_URL}/api/meetings`, { headers: getHeaders() });
    const list = await res.json();
    if (!res.ok) throw new Error(list.error);

    const container = document.getElementById('owner-meetings-timeline');
    if (list.length === 0) {
      container.innerHTML = '<p style="color:var(--text-muted);">No scheduled briefings found.</p>';
      return;
    }

    container.innerHTML = list.map(meet => {
      let statusMeta = '';
      if (meet.status === 'scheduled') {
        statusMeta = `<button class="btn-primary" style="margin-top: 10px; padding: 5px 12px; font-size: 12px; background:#704df4; border:none; cursor:pointer;" onclick="joinMeetingRoom('${meet.id}')">🎥 Join Room</button>`;
      } else if (meet.status === 'pending_approval') {
        statusMeta = `<div style="margin-top: 10px; font-size:11px; color:#ff9f43; font-style:italic;">⏳ Awaiting Admin Approval</div>`;
      } else if (meet.status === 'rejected') {
        statusMeta = `<div style="margin-top: 10px; font-size:11px; color:red; font-style:italic;">❌ Request Rejected</div>`;
      } else if (meet.status === 'completed') {
        statusMeta = `<div style="margin-top: 10px; font-size:11px; color:green; font-style:italic;">✅ Meeting Completed</div>`;
      }

      const participantsHtml = meet.participant_names && meet.participant_names.length > 0
        ? `<div style="margin-top:6px; font-size:12px; color:var(--text-secondary);">👥 Participants: ${meet.participant_names.join(', ')}</div>`
        : '';

      return `
      <div class="timeline-item">
        <div class="timeline-title">${meet.title}</div>
        <div class="timeline-date">Scheduled: ${new Date(meet.date_time).toLocaleString()}</div>
        ${meet.notes ? `<div style="margin-top:10px; font-size:13px; color:var(--text-secondary);"><strong>Notes:</strong> ${meet.notes}</div>` : ''}
        ${meet.follow_ups ? `<div style="margin-top:5px; font-size:13px; color:var(--text-secondary);"><strong>Actions:</strong> ${meet.follow_ups}</div>` : ''}
        ${participantsHtml}
        ${statusMeta}
      </div>
      `;
    }).join('');

    // Load participants for the owner meeting form
    const usersRes = await fetch(`${API_URL}/api/users`, { headers: getHeaders() });
    const usersData = await usersRes.json();
    const users = Array.isArray(usersData) ? usersData : [];
    const pContainer = document.getElementById('owner-meet-participants');
    if (pContainer) {
      pContainer.innerHTML = users.map(u => `
        <div style="display:flex; align-items:center; gap:8px; padding:6px 0; border-bottom:1px solid rgba(255,255,255,0.05);">
          <input type="checkbox" class="ow-participant-check" value="${u.id}" id="owp-${u.id}">
          <label for="owp-${u.id}" style="font-size:13px;">${u.full_name} (${u.role})</label>
        </div>
      `).join('');
    }
  } catch (err) {
    showToast('error', err.message);
  }
}

async function handleOwnerScheduleMeeting(e) {
  e.preventDefault();
  const title = document.getElementById('owner-meet-title').value;
  const date_time = document.getElementById('owner-meet-datetime').value;
  const participants = [];
  document.querySelectorAll('#owner-meet-participants .ow-participant-check:checked').forEach(cb => participants.push(cb.value));

  try {
    const res = await fetch(`${API_URL}/api/meetings`, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify({ title, date_time, participants })
    });
    if (!res.ok) throw new Error('Meeting request failed');

    showToast('success', 'Meeting scheduling request submitted');
    document.getElementById('owner-schedule-meeting-form').reset();
    loadOwnerMeetings();
  } catch (err) {
    showToast('error', err.message);
  }
}

// 12. Video Editor Dashboard
async function loadEditorDashboard() {
  try {
    const res = await fetch(`${API_URL}/api/content`, { headers: getHeaders() });
    const list = await res.json();
    if (!res.ok) throw new Error(list.error);

    const tbody = document.querySelector('#editor-tasks-table tbody');
    if (list.length === 0) {
      tbody.innerHTML = '<tr><td colspan="5" class="text-center">No assigned video tasks.</td></tr>';
      return;
    }

    tbody.innerHTML = list.map(item => {
      let rawLink = '';
      if (item.raw_video_urls && item.raw_video_urls.length > 0) {
        const links = item.raw_video_urls.map((url, i) => `<a href="${API_URL}${url}" target="_blank" class="doc-download-link" style="font-size:11px; margin-right:5px;">Video ${i+1}</a>`).join('');
        const downloadAllBtn = `<button class="btn-secondary" style="padding:4px 8px; font-size:10px; margin-top:5px; display:block;" onclick="downloadAllVideos(${JSON.stringify(item.raw_video_urls).replace(/"/g, '&quot;')})">⬇️ Download All (${item.raw_video_urls.length})</button>`;
        rawLink = `${links}${downloadAllBtn}`;
      } else if (item.raw_video_url) {
        rawLink = `<a href="${API_URL}${item.raw_video_url}" target="_blank" class="doc-download-link" style="font-size:12px;">⬇️ Raw Video</a>`;
      } else {
        rawLink = '<span style="color:var(--text-muted);">No raw videos</span>';
      }

      return `
      <tr>
        <td><strong>${item.business_name}</strong></td>
        <td>
          Idea: ${item.content_idea}
          <br><small style="color:var(--text-muted)">Instructions: ${item.instructions}</small>
        </td>
        <td>${item.deadline}</td>
        <td><span class="badge ${item.status === 'editor_submitted' ? 'badge-approved' : 'badge-pending'}">${item.status}</span></td>
        <td>
          <div style="display:flex; flex-direction:column; gap:8px;">
            ${rawLink}
            ${item.status === 'assigned_editor' 
              ? `<button class="btn-primary" style="padding:6px 12px; font-size:12px; margin-top:5px;" onclick="openEditorSubmitModal('${item.id}')">Submit Work</button>`
              : '<span style="color:var(--text-muted)">Submitted</span>'}
          </div>
        </td>
      </tr>
      `;
    }).join('');

    // Load meetings in dashboard
    loadEmployeeMeetings('editor-meetings-timeline');
  } catch (err) {
    showToast('error', err.message);
  }
}

function openEditorSubmitModal(id) {
  document.getElementById('editor-submit-item-id').value = id;
  document.getElementById('editor-submit-modal').classList.remove('hidden');
}

function closeEditorSubmitModal() {
  document.getElementById('editor-submit-modal').classList.add('hidden');
}

async function handleEditorSubmitDeliverable(e) {
  e.preventDefault();
  const id = document.getElementById('editor-submit-item-id').value;
  const edited_video_url = document.getElementById('editor-video-url').value;
  const editor_notes = document.getElementById('editor-delivery-notes').value;

  if (!edited_video_url.includes('drive.google.com') && !edited_video_url.includes('google.com/drive')) {
    return showToast('error', 'Please provide a valid Google Drive link (e.g. https://drive.google.com/...) as requested.');
  }

  try {
    const res = await fetch(`${API_URL}/api/content/${id}/editor-submit`, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify({ edited_video_url, editor_notes })
    });
    if (!res.ok) throw new Error('Submission failed');

    showToast('success', 'Google Drive link of edited deliverable video submitted successfully');
    closeEditorSubmitModal();
    document.getElementById('editor-submit-form').reset();
    loadEditorDashboard();
  } catch (err) {
    showToast('error', err.message);
  }
}

// 13. Social Media Manager Desk
async function loadSmmDashboard() {
  try {
    const res = await fetch(`${API_URL}/api/content`, { headers: getHeaders() });
    const list = await res.json();
    if (!res.ok) throw new Error(list.error);

    const tbody = document.querySelector('#smm-assets-table tbody');
    if (list.length === 0) {
      tbody.innerHTML = '<tr><td colspan="5" class="text-center">No social media assets assigned to publish.</td></tr>';
      return;
    }

    tbody.innerHTML = list.map(item => `
      <tr>
        <td><strong>${item.business_name}</strong></td>
        <td><a href="${item.edited_video_url}" target="_blank" class="doc-download-link">🎥 Stream Approved Video</a></td>
        <td>${item.instructions}</td>
        <td><span class="badge ${item.status === 'published' ? 'badge-success' : 'badge-pending'}">${item.status}</span></td>
        <td>
          ${item.status === 'assigned_sm_manager'
            ? `<button class="btn-primary" style="padding:6px 12px; font-size:12px;" onclick="openSmmPublishModal('${item.id}')">Publish Live Links</button>`
            : '<span style="color:var(--text-muted)">Published</span>'}
        </td>
      </tr>
    `).join('');

    // Load meetings in dashboard
    loadEmployeeMeetings('smm-meetings-timeline');
  } catch (err) {
    showToast('error', err.message);
  }
}

function openSmmPublishModal(id) {
  document.getElementById('smm-publish-item-id').value = id;
  document.getElementById('smm-publish-modal').classList.remove('hidden');
}

function closeSmmPublishModal() {
  document.getElementById('smm-publish-modal').classList.add('hidden');
}

async function handleSmmPublishProof(e) {
  e.preventDefault();
  const id = document.getElementById('smm-publish-item-id').value;
  const live_post_urls = {
    tiktok: document.getElementById('smm-tiktok-url').value,
    instagram: document.getElementById('smm-ig-url').value,
    facebook: document.getElementById('smm-fb-url').value,
    shorts: document.getElementById('smm-yt-url').value
  };

  try {
    const res = await fetch(`${API_URL}/api/content/${id}/sm-publish`, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify({ live_post_urls })
    });
    if (!res.ok) throw new Error('Proof submission failed');

    showToast('success', 'Social post live URLs documented');
    closeSmmPublishModal();
    document.getElementById('smm-publish-form').reset();
    loadSmmDashboard();
  } catch (err) {
    showToast('error', err.message);
  }
}

// 14. Mentee Growth Center
async function loadMenteeWorkspace() {
  try {
    const res = await fetch(`${API_URL}/api/mentorship/requests`, { headers: getHeaders() });
    const list = await res.json();
    if (!res.ok) throw new Error(list.error);

    const timeline = document.getElementById('mentee-sessions-timeline');
    if (list.length === 0) {
      timeline.innerHTML = '<p style="color:var(--text-muted);">No mentorship logs or session requests.</p>';
      return;
    }

    timeline.innerHTML = list.map(sess => `
      <div class="timeline-node">
        <div class="timeline-node-content">
          <strong>Session Request: ${sess.topics}</strong>
          <div style="font-size:12px; margin-top:4px;">Status: <span class="badge ${sess.status === 'approved' ? 'badge-success' : 'badge-pending'}">${sess.status.toUpperCase()}</span></div>
          <div style="font-size:13px; margin-top:8px; display:flex; flex-direction:column; gap:4px;">
            <div><strong>Challenges:</strong> ${sess.challenges}</div>
            ${sess.meeting_date ? `<div><strong>Scheduled Session:</strong> ${new Date(sess.meeting_date).toLocaleString()}</div>` : ''}
            ${sess.notes ? `<div style="margin-top:10px; color:var(--text-secondary);"><strong>Advisor Notes:</strong> ${sess.notes}</div>` : ''}
            ${sess.recommendations ? `<div style="color:var(--text-secondary);"><strong>Advisor Recommendations:</strong> ${sess.recommendations}</div>` : ''}
            ${sess.action_plans && sess.action_plans.length > 0 
              ? `<div style="color:var(--text-secondary);"><strong>Your Action Plan:</strong>
                  <ul style="margin-left:15px; margin-top:4px;">
                    ${sess.action_plans.map(step => `<li>${step}</li>`).join('')}
                  </ul>
                 </div>` 
              : ''}
          </div>
        </div>
      </div>
    `).join('');

    // Load meetings in dashboard
    loadEmployeeMeetings('mentee-meetings-timeline');
  } catch (err) {
    showToast('error', err.message);
  }
}

async function handleMenteeRequest(e) {
  e.preventDefault();
  const challenges = document.getElementById('mentee-challenges').value;
  const topics = document.getElementById('mentee-topics').value;
  const requested_date = document.getElementById('mentee-date').value;

  try {
    const res = await fetch(`${API_URL}/api/mentorship/request`, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify({ challenges, topics, requested_date })
    });
    if (!res.ok) throw new Error('Mentorship request submission failed');

    showToast('success', 'Advisement session request submitted');
    document.getElementById('mentee-request-form').reset();
    loadMenteeWorkspace();
  } catch (err) {
    showToast('error', err.message);
  }
}

// --- NOTIFICATION & TOAST ANNOUNCEMENT SYSTEM ---

function showToast(type, message) {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.innerText = message;
  container.appendChild(toast);

  setTimeout(() => {
    toast.remove();
  }, 4000);
}

let notifiedIds = null;

function showDesktopNotification(title, body) {
  if (!("Notification" in window)) return;
  
  // Use Electron IPC for native notifications when running in Electron
  if (isDesktopApp && window.electronAPI) {
    try {
      window.electronAPI.showNotification(title, body);
      return;
    } catch (e) {
      console.warn('Electron IPC notification failed, falling back to HTML5:', e);
    }
  }
  
  if (Notification.permission === "granted") {
    try {
      new Notification(title, {
        body: body,
        icon: 'ascentra_logo.jpg',
        requireInteraction: true,
        tag: 'ascentra-chat'
      });
    } catch (e) {
      console.warn("HTML5 Notification constructor failed, trying service worker:", e);
      if (navigator.serviceWorker && navigator.serviceWorker.ready) {
        navigator.serviceWorker.ready.then(registration => {
          registration.showNotification(title, {
            body: body,
            icon: 'ascentra_logo.jpg',
            requireInteraction: true,
            tag: 'ascentra-chat'
          });
        });
      }
    }
  } else if (Notification.permission !== "denied") {
    Notification.requestPermission().then(permission => {
      if (permission === "granted") {
        showDesktopNotification(title, body);
      }
    });
  }
}

async function loadNotifications() {
  try {
    const res = await fetch(`${API_URL}/api/notifications`, { headers: getHeaders() });
    const list = await res.json();
    if (!res.ok) throw new Error(list.error);

    const bellCount = document.getElementById('notification-count');
    const unread = list.filter(n => !n.is_read);
    bellCount.innerText = unread.length;

    // Track which ones have been shown to avoid duplicate alerts
    if (notifiedIds === null) {
      // First load: just cache current notification IDs so we don't alert old notifications
      notifiedIds = new Set(list.map(n => n.id));
    } else {
      // Subsequent loads: check for any new notifications
      list.forEach(n => {
        if (!notifiedIds.has(n.id)) {
          notifiedIds.add(n.id);
          // Show system notification alert for new unread notifications
          if (!n.is_read) {
            showDesktopNotification(n.title, n.message);
          }
        }
      });
    }

    const listContainer = document.getElementById('notifications-list');
    if (list.length === 0) {
      listContainer.innerHTML = '<p class="text-center" style="color:var(--text-muted); font-size:12px; margin-top:20px;">No notifications</p>';
      return;
    }

    listContainer.innerHTML = list.map(n => `
      <div class="notification-item ${n.is_read ? 'read' : ''}">
        <div class="notification-title">${n.title}</div>
        <div class="notification-msg">${n.message}</div>
      </div>
    `).join('');
  } catch (err) {
    console.error('Error loading notifications', err);
  }
}

async function markAllNotificationsRead() {
  try {
    await fetch(`${API_URL}/api/notifications/read-all`, {
      method: 'POST',
      headers: getHeaders()
    });
    loadNotifications();
    showToast('success', 'Notifications read');
  } catch (err) {
    console.error('Error clearing notifications', err);
  }
}

function toggleNotificationsModal() {
  document.getElementById('notifications-modal').classList.toggle('hidden');
}

function startNotificationsPoll() {
  setInterval(() => {
    if (currentToken) loadNotifications();
  }, 15000); // refresh every 15s
}

// --- AI VOICE AGENT FRONTEND CONTROLLER ---
let speechRecognition = null;
let isVoiceRecording = false;

async function triggerVoiceBriefing(query = null) {
  const statusEl = document.getElementById('voice-agent-status');
  const responseEl = document.getElementById('voice-agent-response');
  const responseText = document.getElementById('voice-response-text');
  const briefingBtn = document.getElementById('voice-briefing-btn');

  // Cancel any running speech synthesis
  window.speechSynthesis.cancel();

  statusEl.innerText = query ? 'Status: Question received. Analyzing system...' : 'Status: Preparing briefing. Summarizing platform workflows...';
  briefingBtn.innerText = '⏳ Processing...';
  briefingBtn.disabled = true;

  try {
    const res = await fetch(`${API_URL}/api/admin/voice-agent`, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify({ query })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Voice assistant request failed');

    statusEl.innerText = 'Status: Reading briefing aloud...';
    responseEl.classList.remove('hidden');
    responseText.innerText = data.speechText;

    // Use Web Speech Synthesis to speak aloud
    const utterance = new SpeechSynthesisUtterance(data.speechText);
    utterance.lang = 'en-US';
    utterance.rate = 1.2; // Fast-paced and professional
    utterance.pitch = 1.05; // Slightly higher pitch for a natural feminine sound

    // Search for a natural, premium female English voice
    const voices = allVoices.length > 0 ? allVoices : window.speechSynthesis.getVoices();
    let preferredVoice = voices.find(v => 
      v.lang.includes('en') && 
      (v.name.toLowerCase().includes('female') || 
       v.name.toLowerCase().includes('zira') || 
       v.name.toLowerCase().includes('hazel') || 
       v.name.toLowerCase().includes('susan') || 
       v.name.toLowerCase().includes('aria') || 
       v.name.toLowerCase().includes('heera') || 
       v.name.toLowerCase().includes('google us english') || 
       v.name.toLowerCase().includes('natural') || 
       v.name.toLowerCase().includes('guy') === false) // exclude male voices
    );

    // Fallback if no specific female voice was matched
    if (!preferredVoice) {
      preferredVoice = voices.find(v => v.lang.includes('en'));
    }

    if (preferredVoice) utterance.voice = preferredVoice;

    utterance.onend = () => {
      statusEl.innerText = 'Status: Readout complete. Idle.';
    };

    window.speechSynthesis.speak(utterance);
  } catch (err) {
    statusEl.innerText = 'Status: Error fetching briefing summary';
    showToast('error', err.message);
  } finally {
    briefingBtn.innerText = '📣 Readout Briefing';
    briefingBtn.disabled = false;
  }
}

async function submitTextQuery() {
  const inputEl = document.getElementById('voice-text-query');
  const query = inputEl.value.trim();
  if (!query) return;

  const transcriptPanel = document.getElementById('voice-agent-transcript');
  const transcriptText = document.getElementById('voice-transcript-text');

  transcriptPanel.classList.remove('hidden');
  transcriptText.innerText = query;

  inputEl.value = '';
  await triggerVoiceBriefing(query);
}

let voiceMediaRecorder = null;
let voiceAudioChunks = [];

async function toggleSpeechRecognition() {
  const statusEl = document.getElementById('voice-agent-status');
  const recordBtn = document.getElementById('voice-record-btn');
  const transcriptPanel = document.getElementById('voice-agent-transcript');
  const transcriptText = document.getElementById('voice-transcript-text');

  // Cancel any ongoing speaking
  window.speechSynthesis.cancel();

  if (isVoiceRecording) {
    // Stop recording
    if (voiceMediaRecorder && voiceMediaRecorder.state !== 'inactive') {
      voiceMediaRecorder.stop();
    }
    return;
  }

  // Start recording
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    return showToast('error', 'Microphone access is not supported. Please use HTTPS or localhost to enable voice commands.');
  }

  if (typeof MediaRecorder === 'undefined') {
    return showToast('error', 'Audio recording is not supported in this browser.');
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    
    voiceAudioChunks = [];
    // Choose fallback audio format depending on device capabilities safely (especially for Safari/iOS)
    let options = {};
    if (typeof MediaRecorder.isTypeSupported === 'function') {
      if (MediaRecorder.isTypeSupported('audio/webm')) {
        options = { mimeType: 'audio/webm' };
      } else if (MediaRecorder.isTypeSupported('audio/ogg')) {
        options = { mimeType: 'audio/ogg' };
      } else if (MediaRecorder.isTypeSupported('audio/mp4')) {
        options = { mimeType: 'audio/mp4' };
      } else if (MediaRecorder.isTypeSupported('audio/wav')) {
        options = { mimeType: 'audio/wav' };
      }
    }

    voiceMediaRecorder = new MediaRecorder(stream, options);
    
    voiceMediaRecorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) {
        voiceAudioChunks.push(event.data);
      }
    };

    voiceMediaRecorder.onstart = () => {
      isVoiceRecording = true;
      statusEl.innerText = 'Status: Recording voice... Speak clearly and tap stop when done.';
      recordBtn.innerText = '🛑 Stop Recording';
      recordBtn.style.background = 'red';
    };

    voiceMediaRecorder.onstop = async () => {
      isVoiceRecording = false;
      recordBtn.innerText = '🎤 Tap to Talk';
      recordBtn.style.background = '';
      statusEl.innerText = 'Status: Transcribing audio...';

      // Release microphone resources
      stream.getTracks().forEach(track => track.stop());

      // Create audio blob
      const audioBlob = new Blob(voiceAudioChunks, { type: voiceMediaRecorder.mimeType || 'audio/webm' });
      if (audioBlob.size === 0) {
        statusEl.innerText = 'Status: Error (No audio captured)';
        return;
      }

      // Upload to backend for Whisper transcription
      const formData = new FormData();
      formData.append('file', audioBlob, 'voice-briefing.webm');

      try {
        const res = await fetch(`${API_URL}/api/voice-agent/transcribe`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${currentToken}`
          },
          body: formData
        });

        if (!res.ok) {
          const errData = await res.json();
          throw new Error(errData.error || 'Failed to transcribe audio');
        }

        const result = await res.json();
        const queryText = result.text ? result.text.trim() : '';
        
        if (!queryText) {
          statusEl.innerText = 'Status: Ready (No speech detected)';
          showToast('warning', 'Could not detect any speech. Please try again.');
          return;
        }

        statusEl.innerText = 'Status: Ready';
        transcriptPanel.classList.remove('hidden');
        transcriptText.innerText = queryText;

        // Trigger custom AI Voice Agent briefing with transcribed query
        triggerVoiceBriefing(queryText);
      } catch (err) {
        console.error('Transcription error:', err);
        statusEl.innerText = `Status: Transcription error (${err.message})`;
        showToast('error', 'Transcription failed: ' + err.message);
      }
    };

    voiceMediaRecorder.start();
  } catch (err) {
    console.error('Failed to get mic stream:', err);
    statusEl.innerText = 'Status: Microphone access denied or failed.';
    showToast('error', 'Microphone error: ' + err.message);
  }
}

// Bulk download helper
function downloadAllVideos(urls) {
  if (!urls || urls.length === 0) return;
  showToast('info', `Starting bulk download of ${urls.length} files...`);
  urls.forEach((url, index) => {
    setTimeout(() => {
      const a = document.createElement('a');
      a.href = url.startsWith('http') ? url : `${API_URL}${url}`;
      a.setAttribute('download', url.substring(url.lastIndexOf('/') + 1));
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    }, index * 500); // 500ms delay to avoid popup blocker
  });
}

// 15. Strategic Portfolio Audit Desk
let auditChartsInstance = null;

async function loadAdminAuditDesk() {
  try {
    const res = await fetch(`${API_URL}/api/businesses`, { headers: getHeaders() });
    const list = await res.json();
    const select = document.getElementById('audit-select-business');
    select.innerHTML = '<option value="">-- Choose a Business --</option>' + 
      list.map(b => `<option value="${b.id}">${b.business_name}</option>`).join('');

    document.getElementById('audit-details-container').classList.add('hidden');
    loadAdminUserManagement();
  } catch (err) {
    showToast('error', 'Error loading audit desk: ' + err.message);
  }
}

async function loadAdminUserManagement() {
  try {
    const res = await fetch(`${API_URL}/api/users`, { headers: getHeaders() });
    const usersData = await res.json();
    if (!res.ok) throw new Error(usersData.error);
    const users = Array.isArray(usersData) ? usersData : [];

    const tbody = document.querySelector('#admin-user-management-table tbody');
    tbody.innerHTML = users.map(u => `
      <tr>
        <td><strong>${u.full_name}</strong></td>
        <td>${u.email}</td>
        <td>${u.role}</td>
        <td><span class="badge ${u.status === 'approved' ? 'badge-success' : 'badge-pending'}">${u.status}</span></td>
        <td>${new Date(u.created_at || Date.now()).toLocaleDateString()}</td>
        <td>
          ${u.status === 'pending'
            ? `<button class="btn-primary" onclick="approveUserStatus('${u.id}', 'approved')" style="padding:4px 8px; font-size:11px; background:green;">Approve</button>`
            : `<button class="btn-secondary" onclick="approveUserStatus('${u.id}', 'pending')" style="padding:4px 8px; font-size:11px; color:red; border-color:red;">Suspend</button>`
          }
        </td>
      </tr>
    `).join('');
  } catch (err) {
    showToast('error', 'Error loading user management: ' + err.message);
  }
}

async function approveUserStatus(userId, status) {
  try {
    const res = await fetch(`${API_URL}/api/users/${userId}/status`, {
      method: 'PATCH',
      headers: getHeaders(),
      body: JSON.stringify({ status })
    });
    if (!res.ok) throw new Error('Failed to update user status');
    showToast('success', `User status updated to ${status}`);
    loadAdminUserManagement();
    const selectedBusId = document.getElementById('audit-select-business').value;
    if (selectedBusId) handleSelectBusinessAudit(selectedBusId);
  } catch (err) {
    showToast('error', err.message);
  }
}

async function handleSelectBusinessAudit(businessId) {
  if (!businessId) {
    document.getElementById('audit-details-container').classList.add('hidden');
    return;
  }

  try {
    const res = await fetch(`${API_URL}/api/businesses`, { headers: getHeaders() });
    const list = await res.json();
    const bus = list.find(b => b.id === businessId);
    if (!bus) return;

    document.getElementById('audit-details-container').classList.remove('hidden');

    const profileInfo = document.getElementById('audit-profile-info');
    profileInfo.innerHTML = `
      <div><strong>Business Name:</strong> ${bus.business_name}</div>
      <div><strong>Industry:</strong> ${bus.industry}</div>
      <div><strong>Location:</strong> ${bus.location}</div>
      <div><strong>Employee Count:</strong> ${bus.employee_count}</div>
      <div><strong>Owner:</strong> ${bus.owner_name}</div>
      <div><strong>Description:</strong> ${bus.description || 'N/A'}</div>
      <div><strong>Workflow Status:</strong> <span class="badge ${bus.status === 'approved' ? 'badge-success' : 'badge-pending'}">${bus.status.toUpperCase()}</span></div>
    `;

    const contractsContainer = document.getElementById('audit-contracts-container');
    if (bus.contracts && bus.contracts.length > 0) {
      contractsContainer.innerHTML = '<h5>Agreement Contracts:</h5>' + bus.contracts.map((c, i) => `
        <a href="${API_URL}${c}" target="_blank" class="doc-download-link" style="margin-top:5px; display:inline-block;">⬇️ Download Agreement ${i+1}</a>
      `).join('<br>');
    } else {
      contractsContainer.innerHTML = '<h5>Agreement Contracts:</h5><p style="color:var(--text-muted); font-size:12px;">No contract documents uploaded.</p>';
    }

    renderAuditAnalyticsChart(bus.revenue_insights);

    const empTableBody = document.querySelector('#audit-employees-table tbody');
    if (bus.employees && bus.employees.length > 0) {
      empTableBody.innerHTML = bus.employees.map(emp => `
        <tr>
          <td><strong>${emp.name}</strong></td>
          <td>${emp.role}</td>
          <td>${emp.email || 'N/A'}</td>
          <td><span class="badge badge-success">${emp.status || 'Active'}</span></td>
          <td>${emp.joined_date || 'N/A'}</td>
        </tr>
      `).join('');
    } else {
      empTableBody.innerHTML = '<tr><td colspan="5" class="text-center">No employee records registered in portfolio.</td></tr>';
    }

    const contentRes = await fetch(`${API_URL}/api/content`, { headers: getHeaders() });
    const contentItems = await contentRes.json();
    const filteredContent = contentItems.filter(item => item.business_id === businessId);

    const contentTableBody = document.querySelector('#audit-content-table tbody');
    if (filteredContent.length === 0) {
      contentTableBody.innerHTML = '<tr><td colspan="3" class="text-center">No projects in pipeline.</td></tr>';
    } else {
      contentTableBody.innerHTML = filteredContent.map(item => {
        let linksHtml = '';
        if (item.raw_video_urls && item.raw_video_urls.length > 0) {
          linksHtml += item.raw_video_urls.map((url, i) => `<a href="${API_URL}${url}" target="_blank" style="margin-right:8px; font-size:11px; color:var(--accent-cyan);">Raw ${i+1}</a>`).join('');
        } else if (item.raw_video_url) {
          linksHtml += `<a href="${API_URL}${item.raw_video_url}" target="_blank" style="font-size:11px; color:var(--accent-cyan);">Raw Video</a>`;
        }
        if (item.edited_video_url) {
          linksHtml += `<br><a href="${item.edited_video_url}" target="_blank" style="font-size:11px; color:#2ed573;">Edited Deliverable</a>`;
        }
        return `
          <tr>
            <td><strong>${item.content_idea}</strong></td>
            <td><span class="badge badge-pending">${item.status}</span></td>
            <td>${linksHtml}</td>
          </tr>
        `;
      }).join('');
    }

    const ordersRes = await fetch(`${API_URL}/api/orders`, { headers: getHeaders() });
    const ordersList = await ordersRes.json();
    const filteredOrders = ordersList.filter(o => o.business_id === businessId);

    const ordersTableBody = document.querySelector('#audit-orders-table tbody');
    if (filteredOrders.length === 0) {
      ordersTableBody.innerHTML = '<tr><td colspan="4" class="text-center">No client orders recorded.</td></tr>';
    } else {
      ordersTableBody.innerHTML = filteredOrders.map(o => `
        <tr>
          <td><strong>${o.client_name}</strong></td>
          <td>${o.product_service}</td>
          <td>$${parseFloat(o.amount).toFixed(2)}</td>
          <td><span class="badge ${o.status === 'completed' ? 'badge-success' : 'badge-pending'}">${o.status}</span></td>
        </tr>
      `).join('');
    }

    const reportsRes = await fetch(`${API_URL}/api/reports`, { headers: getHeaders() });
    const reportsList = await reportsRes.json();
    const filteredReports = reportsList.filter(r => r.business_id === businessId);

    const reportsTimeline = document.getElementById('audit-reports-timeline');
    if (filteredReports.length === 0) {
      reportsTimeline.innerHTML = '<p class="text-center" style="color:var(--text-muted); font-size:13px; padding:15px;">No daily reports submitted yet.</p>';
    } else {
      reportsTimeline.innerHTML = filteredReports.map(rep => `
        <div class="timeline-node">
          <div class="timeline-node-content">
            <strong>Daily Report (${rep.date})</strong>
            <div style="margin-top:8px; font-size:13px; display:flex; flex-direction:column; gap:6px;">
              <div><strong>Activities:</strong> ${rep.activities}</div>
              <div><strong>Active Projects:</strong> ${rep.active_projects}</div>
              <div><strong>Team Progress:</strong> ${rep.progress}</div>
              <div><strong>Challenges:</strong> ${rep.challenges}</div>
              <div><strong>Goals:</strong> ${rep.goals}</div>
              ${rep.updates ? `<div><strong>Notes/Updates:</strong> ${rep.updates}</div>` : ''}
            </div>
          </div>
        </div>
      `).join('');
    }

    const invoicesRes = await fetch(`${API_URL}/api/invoices`, { headers: getHeaders() });
    const invoicesList = await invoicesRes.json();
    const filteredInvoices = invoicesList.filter(inv => inv.business_id === businessId);

    const invoicesTableBody = document.querySelector('#audit-invoices-table tbody');
    if (filteredInvoices.length === 0) {
      invoicesTableBody.innerHTML = '<tr><td colspan="5" class="text-center">No invoice history.</td></tr>';
    } else {
      invoicesTableBody.innerHTML = filteredInvoices.map(inv => `
        <tr>
          <td><strong>${inv.invoice_number}</strong></td>
          <td>${inv.client_name}</td>
          <td>${inv.due_date}</td>
          <td>$${parseFloat(inv.total).toFixed(2)}</td>
          <td><span class="badge ${inv.status === 'paid' ? 'badge-success' : 'badge-pending'}">${inv.status.toUpperCase()}</span></td>
        </tr>
      `).join('');
    }

  } catch (err) {
    showToast('error', 'Error rendering business audit details: ' + err.message);
  }
}

function renderAuditAnalyticsChart(insights) {
  if (!insights) return;
  const ctx = document.getElementById('auditAnalyticsChart').getContext('2d');
  
  if (auditChartsInstance) auditChartsInstance.destroy();

  auditChartsInstance = new Chart(ctx, {
    type: 'line',
    data: {
      labels: insights.map(i => i.month),
      datasets: [
        {
          label: 'Monthly Revenue ($)',
          data: insights.map(i => i.revenue),
          borderColor: '#704df4',
          backgroundColor: 'rgba(112, 77, 244, 0.1)',
          fill: true,
          tension: 0.4
        },
        {
          label: 'Monthly Profit ($)',
          data: insights.map(i => i.profit),
          borderColor: '#00d2ff',
          backgroundColor: 'rgba(0, 210, 255, 0.1)',
          fill: true,
          tension: 0.4
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        y: { grid: { color: 'rgba(255, 255, 255, 0.05)' }, ticks: { color: '#a4a9c6' } },
        x: { grid: { color: 'rgba(255, 255, 255, 0.05)' }, ticks: { color: '#a4a9c6' } }
      },
      plugins: {
        legend: { labels: { color: '#f1f2f6' } }
      }
    }
  });
}

// 16. Owner Client Orders & Employees Loader
async function loadOwnerOrdersDesk() {
  loadOwnerOrdersList();
  loadOwnerEmployees();
}

async function loadOwnerOrdersList() {
  try {
    const res = await fetch(`${API_URL}/api/orders`, { headers: getHeaders() });
    const list = await res.json();
    if (!res.ok) throw new Error(list.error);

    const tbody = document.querySelector('#owner-orders-table tbody');
    if (list.length === 0) {
      tbody.innerHTML = '<tr><td colspan="5" class="text-center">No orders recorded.</td></tr>';
      return;
    }

    tbody.innerHTML = list.map(o => `
      <tr>
        <td><strong>${o.client_name}</strong></td>
        <td>${o.product_service}</td>
        <td>$${parseFloat(o.amount).toFixed(2)}</td>
        <td><span class="badge ${o.status === 'completed' ? 'badge-success' : 'badge-pending'}">${o.status}</span></td>
        <td>
          <select onchange="updateOrderStatus('${o.id}', this.value)" style="padding:4px; font-size:12px;">
            <option value="pending" ${o.status === 'pending' ? 'selected' : ''}>Pending</option>
            <option value="in_progress" ${o.status === 'in_progress' ? 'selected' : ''}>In Progress</option>
            <option value="completed" ${o.status === 'completed' ? 'selected' : ''}>Completed</option>
            <option value="cancelled" ${o.status === 'cancelled' ? 'selected' : ''}>Cancelled</option>
          </select>
        </td>
      </tr>
    `).join('');
  } catch (err) {
    showToast('error', err.message);
  }
}

async function updateOrderStatus(id, status) {
  try {
    const res = await fetch(`${API_URL}/api/orders/${id}/status`, {
      method: 'PATCH',
      headers: getHeaders(),
      body: JSON.stringify({ status })
    });
    if (!res.ok) throw new Error('Order status update failed');
    showToast('success', 'Order status updated');
    loadOwnerOrdersList();
  } catch (err) {
    showToast('error', err.message);
  }
}

function openCreateOrderModal() {
  document.getElementById('order-modal').classList.remove('hidden');
}

function closeCreateOrderModal() {
  document.getElementById('order-modal').classList.add('hidden');
}

async function handleCreateOrder(e) {
  e.preventDefault();
  const client_name = document.getElementById('ord-client-name').value;
  const product_service = document.getElementById('ord-product').value;
  const amount = parseFloat(document.getElementById('ord-amount').value);
  const status = document.getElementById('ord-status').value;
  const notes = document.getElementById('ord-notes').value;

  try {
    const res = await fetch(`${API_URL}/api/orders`, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify({ client_name, product_service, amount, status, notes })
    });
    if (!res.ok) throw new Error('Failed to record order');
    showToast('success', 'Client order recorded');
    closeCreateOrderModal();
    document.getElementById('order-creation-form').reset();
    loadOwnerOrdersList();
  } catch (err) {
    showToast('error', err.message);
  }
}

async function loadOwnerEmployees() {
  try {
    const res = await fetch(`${API_URL}/api/businesses/my/employees`, { headers: getHeaders() });
    const list = await res.json();
    if (!res.ok) throw new Error(list.error);

    const tbody = document.querySelector('#owner-employees-table tbody');
    if (list.length === 0) {
      tbody.innerHTML = '<tr><td colspan="4" class="text-center">No employee records registered.</td></tr>';
      return;
    }

    tbody.innerHTML = list.map(emp => `
      <tr>
        <td><strong>${emp.name}</strong></td>
        <td>${emp.role}</td>
        <td>${emp.email || 'N/A'}</td>
        <td>
          <button class="btn-secondary" style="padding:4px 8px; font-size:11px; color:red; border-color:red;" onclick="handleRemoveEmployee('${emp.id}')">Remove</button>
        </td>
      </tr>
    `).join('');
  } catch (err) {
    showToast('error', err.message);
  }
}

async function handleAddEmployee(e) {
  e.preventDefault();
  const name = document.getElementById('emp-name').value;
  const role = document.getElementById('emp-role').value;
  const email = document.getElementById('emp-email').value;

  try {
    const res = await fetch(`${API_URL}/api/businesses/my/employees`, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify({ name, role, email })
    });
    if (!res.ok) throw new Error('Failed to add employee');
    showToast('success', `Employee ${name} added successfully`);
    document.getElementById('owner-add-employee-form').reset();
    loadOwnerEmployees();
  } catch (err) {
    showToast('error', err.message);
  }
}

async function handleRemoveEmployee(empId) {
  if (!confirm('Are you sure you want to remove this employee?')) return;
  try {
    const res = await fetch(`${API_URL}/api/businesses/my/employees/${empId}`, {
      method: 'DELETE',
      headers: getHeaders()
    });
    if (!res.ok) throw new Error('Failed to remove employee');
    showToast('success', 'Employee removed');
    loadOwnerEmployees();
  } catch (err) {
    showToast('error', err.message);
  }
}

// --- MEETING REQUEST APPROVALS & RESCHEDULING ---
async function approveMeeting(id) {
  try {
    const res = await fetch(`${API_URL}/api/meetings/${id}/approve`, {
      method: 'POST',
      headers: getHeaders()
    });
    if (!res.ok) throw new Error('Approval failed');
    showToast('success', 'Meeting request approved');
    loadAdminMeetings();
  } catch (err) {
    showToast('error', err.message);
  }
}

async function rejectMeeting(id) {
  if (!confirm('Are you sure you want to reject this meeting request?')) return;
  try {
    const res = await fetch(`${API_URL}/api/meetings/${id}/reject`, {
      method: 'POST',
      headers: getHeaders()
    });
    if (!res.ok) throw new Error('Rejection failed');
    showToast('success', 'Meeting request rejected');
    loadAdminMeetings();
  } catch (err) {
    showToast('error', err.message);
  }
}

async function rescheduleMeeting(id, currentDateTime) {
  const date_time = prompt('Enter new Date & Time (YYYY-MM-DDTHH:MM):', currentDateTime);
  if (!date_time) return;

  try {
    const res = await fetch(`${API_URL}/api/meetings/${id}/reschedule`, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify({ date_time })
    });
    if (!res.ok) throw new Error('Rescheduling failed');
    showToast('success', 'Meeting rescheduled successfully');
    loadAdminMeetings();
  } catch (err) {
    showToast('error', err.message);
  }
}

// --- VIRTUAL MEETING ROOM DESK ---
let currentMeetingRoomId = null;
let meetingSpeechRecognition = null;
let meetingTranscriptBuffer = '';
let isMeetingRecording = false;

function startMeetingRoomTranscription() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    console.warn('SpeechRecognition is not supported in this browser.');
    document.getElementById('meet-copilot-status').innerText = '🎙️ AI Copilot: Web Speech Not Supported';
    return;
  }

  meetingTranscriptBuffer = '';
  isMeetingRecording = true;
  document.getElementById('meet-copilot-status').innerText = '🎙️ AI Copilot: Listening & Transcribing...';
  
  const startText = 'Starting transcription... Say something to transcribe.';
  const tEl = document.getElementById('meet-room-live-transcript');
  if (tEl) tEl.innerText = startText;
  const mEl = document.getElementById('meet-room-live-transcript-mobile');
  if (mEl) mEl.innerText = startText;

  meetingSpeechRecognition = new SpeechRecognition();
  meetingSpeechRecognition.continuous = true;
  meetingSpeechRecognition.interimResults = true;
  meetingSpeechRecognition.lang = 'en-US';

  meetingSpeechRecognition.onresult = (event) => {
    let interimTranscript = '';
    let finalTranscript = '';

    for (let i = event.resultIndex; i < event.results.length; ++i) {
      if (event.results[i].isFinal) {
        finalTranscript += event.results[i][0].transcript + '. ';
      } else {
        interimTranscript += event.results[i][0].transcript;
      }
    }

    if (finalTranscript) {
      meetingTranscriptBuffer += finalTranscript;
    }

    const displayText = meetingTranscriptBuffer + (interimTranscript ? ` [${interimTranscript}]` : '');
    
    const tEl2 = document.getElementById('meet-room-live-transcript');
    if (tEl2) {
      tEl2.innerText = displayText || 'Listening...';
      tEl2.scrollTop = tEl2.scrollHeight;
    }
    const mEl2 = document.getElementById('meet-room-live-transcript-mobile');
    if (mEl2) {
      mEl2.innerText = displayText || 'Listening...';
      mEl2.scrollTop = mEl2.scrollHeight;
    }
  };

  meetingSpeechRecognition.onerror = (e) => {
    console.error('Speech recognition error in meeting room:', e.error);
    if (e.error === 'no-speech') {
      return;
    }
    if (e.error === 'network' && isDesktopApp) {
      document.getElementById('meet-copilot-status').innerText = '🎙️ AI Copilot: Mic transcription is restricted in Desktop App. Use Chrome browser.';
    } else {
      document.getElementById('meet-copilot-status').innerText = `🎙️ AI Copilot: Error (${e.error})`;
    }
  };

  meetingSpeechRecognition.onend = () => {
    if (isMeetingRecording && currentMeetingRoomId) {
      try {
        meetingSpeechRecognition.start();
      } catch (err) {
        console.error('Failed to restart speech recognition:', err);
      }
    } else {
      document.getElementById('meet-copilot-status').innerText = '🎙️ AI Copilot: Off';
    }
  };

  try {
    meetingSpeechRecognition.start();
  } catch (err) {
    console.error('Error starting speech recognition:', err);
    document.getElementById('meet-copilot-status').innerText = '🎙️ AI Copilot: Failed to Start';
  }
}

function stopMeetingRoomTranscription() {
  isMeetingRecording = false;
  if (meetingSpeechRecognition) {
    try {
      meetingSpeechRecognition.stop();
    } catch (e) {
      console.error(e);
    }
    meetingSpeechRecognition = null;
  }
  document.getElementById('meet-copilot-status').innerText = '🎙️ AI Copilot: Off';
}

async function triggerAIMeetingSummarization() {
  if (!currentMeetingRoomId) return showToast('error', 'No active meeting session loaded');
  
  stopMeetingRoomTranscription();
  
  document.getElementById('meet-copilot-status').innerText = '🤖 AI Copilot: Generating Summarized Notes...';
  showToast('info', 'AI is analyzing meeting transcription...');

  let transcript = meetingTranscriptBuffer.trim();
  if (!transcript) {
    transcript = "Let's review the active client orders. We need to assign the new bulk videos of Apex Solutions to our video editors. The editor will submit Google Drive folder links for review. Also, the team must draft the new branding strategy for GreenPulse Co by next week.";
    showToast('info', 'No speech detected. Using a demo transcript for AI analysis.');
    const dText = `[Demo Transcript]: ${transcript}`;
    const tEl3 = document.getElementById('meet-room-live-transcript');
    if (tEl3) tEl3.innerText = dText;
    const mEl3 = document.getElementById('meet-room-live-transcript-mobile');
    if (mEl3) mEl3.innerText = dText;
  }

  try {
    const res = await fetch(`${API_URL}/api/meetings/summarize-transcript`, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify({ transcript })
    });
    
    if (!res.ok) throw new Error('AI Summarization failed');
    const result = await res.json();
    
    document.getElementById('meet-room-notes').value = result.notes;
    document.getElementById('meet-room-followups').value = result.follow_ups;
    
    document.getElementById('meet-copilot-status').innerText = '✨ AI Copilot: Minutes Ready & Saved!';
    showToast('success', 'AI meeting minutes generated! Saving to database...');

    await handleSaveMeetingRoomMinutes();
  } catch (err) {
    document.getElementById('meet-copilot-status').innerText = '❌ AI Copilot: Summarization Error';
    showToast('error', 'Failed to generate meeting notes: ' + err.message);
  }
}

let jitsiAPIInstance = null;

async function joinMeetingRoom(meetingId) {
  currentMeetingRoomId = meetingId;
  document.body.classList.add('in-meeting');
  switchMainTab('meeting-room');
  switchMeetingTab('video');

  try {
    const res = await fetch(`${API_URL}/api/meetings`, { headers: getHeaders() });
    const list = await res.json();
    const meeting = list.find(m => m.id === meetingId);
    if (!meeting) return showToast('error', 'Meeting details not found');

    document.getElementById('meet-room-title').innerText = `🎥 Secure Jitsi Meeting Room: ${meeting.title}`;
    document.getElementById('meet-room-subtitle').innerText = `Business Portfolio: ${meeting.business_name} | Date: ${new Date(meeting.date_time).toLocaleString()}`;
    document.getElementById('meet-room-notes').value = meeting.notes || '';
    document.getElementById('meet-room-followups').value = meeting.follow_ups || '';

    // Render Jitsi Meet
    const container = document.getElementById('jitsi-meet-container');
    container.innerHTML = ''; // Clear container

    const domain = 'meet.jit.si';
    const options = {
      roomName: `AscentraMeeting-${meetingId}`,
      width: '100%',
      height: '100%',
      parentNode: container,
      userInfo: {
        displayName: currentUser.full_name,
        email: currentUser.email
      },
      configOverwrite: {
        startWithAudioMuted: false,
        startWithVideoMuted: false,
        prejoinPageEnabled: false
      }
    };

    jitsiAPIInstance = new JitsiMeetExternalAPI(domain, options);
    showToast('success', 'Entered secure Jitsi meeting room');
    startMeetingRoomTranscription();
  } catch (err) {
    showToast('error', 'Failed to load meeting room: ' + err.message);
  }
}

function exitMeetingRoom(skipConfirm = false) {
  if (skipConfirm || confirm('Are you sure you want to leave the virtual meeting room?')) {
    document.body.classList.remove('in-meeting');
    stopMeetingRoomTranscription();
    
    // Dispose Jitsi instance
    if (jitsiAPIInstance) {
      jitsiAPIInstance.dispose();
      jitsiAPIInstance = null;
    }

    // Clear WebRTC Signaling if active
    if (currentMeetingRoomId) {
      fetch(`${API_URL}/api/meetings/signal/clear`, {
        method: 'POST',
        headers: getHeaders(),
        body: JSON.stringify({ meetingId: currentMeetingRoomId })
      }).catch(err => console.warn('Failed to clear signals:', err));
    }

    if (localStream) {
      localStream.getTracks().forEach(track => track.stop());
      localStream = null;
    }

    if (peerConnection) {
      peerConnection.close();
      peerConnection = null;
    }

    if (webrtcSignalInterval) {
      clearInterval(webrtcSignalInterval);
      webrtcSignalInterval = null;
    }
    
    document.getElementById('jitsi-meet-container').innerHTML = '';
    currentMeetingRoomId = null;
    showToast('info', 'Left meeting room');
    switchMainTab('dashboard');
  }
}

function switchMeetingTab(tabName) {
  document.querySelectorAll('.meet-tab-btn').forEach(btn => {
    btn.classList.remove('active');
  });
  
  // Highlight active tab
  const activeBtn = Array.from(document.querySelectorAll('.meet-tab-btn')).find(btn => {
    const onclickAttr = btn.getAttribute('onclick');
    return onclickAttr && onclickAttr.includes(tabName);
  });
  if (activeBtn) activeBtn.classList.add('active');

  const videoSection = document.getElementById('meet-tab-content-video');
  const notesSection = document.getElementById('meet-tab-content-notes');

  if (tabName === 'video') {
    if (videoSection) videoSection.classList.remove('meet-tab-hidden-mobile');
    if (notesSection) notesSection.classList.add('meet-tab-hidden-mobile');
  } else {
    if (videoSection) videoSection.classList.add('meet-tab-hidden-mobile');
    if (notesSection) notesSection.classList.remove('meet-tab-hidden-mobile');
  }
}

async function handleSaveMeetingRoomMinutes() {
  if (!currentMeetingRoomId) return showToast('error', 'No active meeting session loaded');

  const notes = document.getElementById('meet-room-notes').value;
  const follow_ups = document.getElementById('meet-room-followups').value;

  try {
    const res = await fetch(`${API_URL}/api/meetings/${currentMeetingRoomId}`, {
      method: 'PUT',
      headers: getHeaders(),
      body: JSON.stringify({ notes, follow_ups, status: 'completed' })
    });
    if (!res.ok) throw new Error('Failed to save meeting room minutes');
    showToast('success', 'Meeting notes and action items saved to database');
  } catch (err) {
    showToast('error', err.message);
  }
}

// Mobile sidebar toggle handler
function toggleMobileSidebar() {
  const sidebar = document.querySelector('.sidebar');
  const overlay = document.getElementById('sidebar-overlay');
  if (sidebar) {
    sidebar.classList.toggle('sidebar-open');
  }
  if (overlay) {
    overlay.classList.toggle('active');
  }
}

// Push notifications initializer
async function initPushNotifications() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    console.warn('Push notifications or Service Workers are not supported in this environment.');
    return;
  }

  try {
    // Service Worker requires HTTPS, localhost, 127.0.0.1, or local protocols (e.g. capacitor://, http://localhost)
    const isSecureContext = window.isSecureContext || 
                            window.location.protocol === 'https:' || 
                            window.location.hostname === 'localhost' || 
                            window.location.hostname === '127.0.0.1' ||
                            window.location.protocol === 'capacitor:';
                            
    if (!isSecureContext) {
      console.warn('Service Worker registration skipped: Non-secure context.');
      return;
    }

    // Register service worker with root scope using absolute path
    const registration = await navigator.serviceWorker.register('/service-worker.js')
      .catch(err => {
        throw new Error('Service Worker registration failed: ' + err.message);
      });
      
    console.log('Service Worker registered:', registration.scope);

    // Wait until the service worker is active and ready
    await navigator.serviceWorker.ready;

    if (!registration.pushManager) {
      console.warn('PushManager is not available on this Service Worker registration.');
      return;
    }

    // Request notification permission
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      console.warn('Push notification permission denied.');
      return;
    }

    // Fetch VAPID public key
    const keyRes = await fetch(`${API_URL}/api/notifications/vapid-public-key`);
    const keyData = await keyRes.json();
    if (!keyRes.ok) throw new Error(keyData.error || 'Failed to fetch public VAPID key');

    // Subscribe to Push Service
    const subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(keyData.publicKey)
    }).catch(err => {
      throw new Error('Push subscription failed: ' + err.message);
    });

    // Send subscription object to backend
    await fetch(`${API_URL}/api/notifications/subscribe`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${currentToken}`
      },
      body: JSON.stringify({ subscription })
    });
    console.log('Successfully subscribed to push notifications!');
  } catch (err) {
    console.error('Error establishing push subscription:', err.message || err);
  }
}

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding)
    .replace(/\-/g, '+')
    .replace(/_/g, '/');
  
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

// Global variable to store active logs for report compilation
let activeAuditLogs = [];
let activeAuditStats = {};

async function loadBossAuditLogs() {
  try {
    const res = await fetch(`${API_URL}/api/admin/dashboard`, { headers: getHeaders() });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);

    activeAuditLogs = data.logs || [];
    activeAuditStats = data.stats || {};

    // Render Metrics
    const metricsGrid = document.getElementById('boss-metrics-grid');
    if (metricsGrid) {
      metricsGrid.innerHTML = `
        <div style="padding:15px; background:rgba(255,255,255,0.02); border-radius:8px; border:1px solid var(--border-color);">
          <div style="font-size:12px; color:var(--text-secondary);">Total Businesses</div>
          <div style="font-size:24px; font-weight:700; color:var(--accent-cyan); margin-top:5px;">${activeAuditStats.total_businesses || 0}</div>
        </div>
        <div style="padding:15px; background:rgba(255,255,255,0.02); border-radius:8px; border:1px solid var(--border-color);">
          <div style="font-size:12px; color:var(--text-secondary);">Active Staff / Team</div>
          <div style="font-size:24px; font-weight:700; color:var(--accent-purple); margin-top:5px;">${activeAuditStats.total_team_members || 0}</div>
        </div>
        <div style="padding:15px; background:rgba(255,255,255,0.02); border-radius:8px; border:1px solid var(--border-color);">
          <div style="font-size:12px; color:var(--text-secondary);">Pending Invoices</div>
          <div style="font-size:24px; font-weight:700; color:#ff9f43; margin-top:5px;">$${parseFloat(activeAuditStats.total_pending_billing || 0).toFixed(2)}</div>
        </div>
        <div style="padding:15px; background:rgba(255,255,255,0.02); border-radius:8px; border:1px solid var(--border-color);">
          <div style="font-size:12px; color:var(--text-secondary);">Total Revenue Billed</div>
          <div style="font-size:24px; font-weight:700; color:#2ed573; margin-top:5px;">$${parseFloat(activeAuditStats.total_billing || 0).toFixed(2)}</div>
        </div>
      `;
    }

    // Render Logs Table
    const tbody = document.querySelector('#boss-activity-logs-table tbody');
    if (tbody) {
      if (activeAuditLogs.length === 0) {
        tbody.innerHTML = '<tr><td colspan="4" class="text-center">No system operations logged yet.</td></tr>';
        return;
      }

      tbody.innerHTML = activeAuditLogs.map(log => `
        <tr>
          <td><small>${new Date(log.created_at).toLocaleString()}</small></td>
          <td><strong>${log.user_id}</strong></td>
          <td><span class="badge badge-active">${log.action.replace(/_/g, ' ')}</span></td>
          <td><span style="color:var(--text-secondary);">${log.details || 'No details provided'}</span></td>
        </tr>
      `).join('');
    }
  } catch (err) {
    showToast('error', 'Error loading boss logs: ' + err.message);
  }
}

function generateExecutiveReport() {
  if (activeAuditLogs.length === 0) {
    return showToast('error', 'No activity logs available to compile a report today.');
  }

  const modal = document.getElementById('boss-report-modal');
  const container = document.getElementById('boss-report-content');

  // Compile breakdown of actions by categories
  const breakdown = {};
  activeAuditLogs.forEach(log => {
    breakdown[log.action] = (breakdown[log.action] || 0) + 1;
  });

  // Compile timeline summaries
  const actionListHTML = activeAuditLogs.slice(0, 10).map(log => `
    <div style="margin-bottom:12px; padding:10px; background:rgba(255,255,255,0.02); border-radius:6px; border-left: 3px solid var(--accent-purple);">
      <div style="display:flex; justify-content:space-between; font-size:12px; color:var(--text-muted);">
        <span>User ID: ${log.user_id}</span>
        <span>${new Date(log.created_at).toLocaleTimeString()}</span>
      </div>
      <div style="margin-top:4px; font-size:13px;">
        <strong>Category:</strong> ${log.action.toUpperCase().replace(/_/g, ' ')} | <strong>Details:</strong> ${log.details}
      </div>
    </div>
  `).join('');

  const breakdownHTML = Object.entries(breakdown).map(([action, count]) => `
    <div style="display:flex; justify-content:space-between; border-bottom: 1px solid rgba(255,255,255,0.05); padding: 8px 0;">
      <span style="text-transform: capitalize;">${action.replace(/_/g, ' ')}</span>
      <strong>${count} operations</strong>
    </div>
  `).join('');

  container.innerHTML = `
    <div style="text-align: center; border-bottom: 2px solid var(--border-color); padding-bottom: 15px; margin-bottom: 20px;">
      <h3 style="margin: 0; color: var(--accent-cyan);">Ascentra Hub OS</h3>
      <h4 style="margin: 5px 0 0 0; color: var(--text-secondary); font-weight: 500;">DAILY EXECUTIVE PERFORMANCE AUDIT SUMMARY</h4>
      <p style="margin: 5px 0 0 0; font-size: 12px; color: var(--text-muted);">Report Generated on: ${new Date().toLocaleString()} | Access Level: OWNER/BOSS</p>
    </div>

    <div style="margin-bottom: 25px;">
      <h5 style="margin-top: 0; margin-bottom: 10px; color: var(--accent-purple); font-size: 14px;">1. STRATEGIC METRICS STATUS</h5>
      <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 15px; font-size: 13px;">
        <div><strong>Total Registered Portfolios:</strong> ${activeAuditStats.total_businesses || 0}</div>
        <div><strong>Total Active Team Staff:</strong> ${activeAuditStats.total_team_members || 0}</div>
        <div><strong>Total Billing Billed (Paid):</strong> $${parseFloat(activeAuditStats.total_billing || 0).toFixed(2)}</div>
        <div><strong>Unpaid Billing Registry:</strong> $${parseFloat(activeAuditStats.total_pending_billing || 0).toFixed(2)}</div>
      </div>
    </div>

    <div style="margin-bottom: 25px;">
      <h5 style="margin-top: 0; margin-bottom: 10px; color: var(--accent-purple); font-size: 14px;">2. OPERATION CATEGORIES SUMMARY (TODAY)</h5>
      <div style="background: rgba(0,0,0,0.2); border-radius: 8px; padding: 12px; font-size: 13px;">
        ${breakdownHTML}
      </div>
    </div>

    <div>
      <h5 style="margin-top: 0; margin-bottom: 10px; color: var(--accent-purple); font-size: 14px;">3. CHRONOLOGICAL OPERATIONS TRAIL (LAST 10 ACTIONS)</h5>
      ${actionListHTML}
    </div>
  `;

  modal.classList.remove('hidden');
}

function closeBossReportModal() {
  document.getElementById('boss-report-modal').classList.add('hidden');
}

function printBossReport() {
  const content = document.getElementById('boss-report-content').innerHTML;
  const printWindow = window.open('', '_blank');
  printWindow.document.write(`
    <html>
      <head>
        <title>Ascentra Executive Operations Report</title>
        <style>
          body {
            background-color: #ffffff;
            color: #111111;
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            padding: 30px;
          }
          h3, h4, h5 {
            color: #333333;
            margin-bottom: 5px;
          }
          div {
            margin-bottom: 15px;
          }
          hr {
            border: 0;
            border-top: 1px solid #ccc;
          }
        </style>
      </head>
      <body>
        ${content}
        <script>
          window.onload = function() {
            window.print();
            window.close();
          };
        </script>
      </body>
    </html>
  `);
  printWindow.document.close();
}

// --- APP ONBOARDING CONTROLLERS ---
let onboardingSlideIdx = 0;

function initOnboardingCarousel() {
  const track = document.getElementById('onboarding-track');
  const slides = document.querySelectorAll('.onboarding-slide');
  const dots = document.querySelectorAll('.onboarding-pagination .onboarding-dot');
  const actionBtn = document.getElementById('btn-onboarding-action');
  
  if (!track || slides.length === 0) return;
  
  const updateSlide = (idx) => {
    track.style.transform = `translateX(-${idx * 20}%)`;
    dots.forEach(d => d.classList.remove('active'));
    if (dots[idx]) dots[idx].classList.add('active');
    
    if (idx === slides.length - 1) {
      actionBtn.innerText = 'Get Started';
    } else {
      actionBtn.innerText = 'Next';
    }
    onboardingSlideIdx = idx;
  };
  
  actionBtn.onclick = () => {
    if (onboardingSlideIdx < slides.length - 1) {
      updateSlide(onboardingSlideIdx + 1);
    } else {
      completeOnboarding();
    }
  };
  
  // Touch Swipe gestures support
  let touchStartVal = 0;
  let touchEndVal = 0;
  
  track.addEventListener('touchstart', (e) => {
    touchStartVal = e.changedTouches[0].screenX;
  }, { passive: true });
  
  track.addEventListener('touchend', (e) => {
    touchEndVal = e.changedTouches[0].screenX;
    handleSwipe();
  }, { passive: true });
  
  const handleSwipe = () => {
    const threshold = 50; // pixels
    if (touchStartVal - touchEndVal > threshold) {
      // Swipe Left (Next)
      if (onboardingSlideIdx < slides.length - 1) {
        updateSlide(onboardingSlideIdx + 1);
      }
    } else if (touchEndVal - touchStartVal > threshold) {
      // Swipe Right (Prev)
      if (onboardingSlideIdx > 0) {
        updateSlide(onboardingSlideIdx - 1);
      }
    }
  };

  // Keyboard arrow key navigation support for desktop
  window.addEventListener('keydown', (e) => {
    const onboardingContainer = document.getElementById('onboarding-container');
    if (onboardingContainer && !onboardingContainer.classList.contains('hidden')) {
      if (e.key === 'ArrowRight') {
        if (onboardingSlideIdx < slides.length - 1) {
          updateSlide(onboardingSlideIdx + 1);
        }
      } else if (e.key === 'ArrowLeft') {
        if (onboardingSlideIdx > 0) {
          updateSlide(onboardingSlideIdx - 1);
        }
      }
    }
  });
}

function completeOnboarding() {
  localStorage.setItem('onboarding-completed', 'true');
  document.getElementById('onboarding-container').classList.add('hidden');
  
  const savedToken = localStorage.getItem('token');
  const savedUser = localStorage.getItem('user');
  if (savedToken && savedUser) {
    initCommandShell();
  } else {
    showAuthPanel();
  }
}

async function requestAppPermissions() {
  try {
    if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
      let stream;
      try {
        // Try getting both camera and microphone
        stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
        showToast('success', 'Camera & Microphone access successfully granted!');
      } catch (mediaErr) {
        console.warn('Dual media request failed, trying audio only...', mediaErr);
        try {
          // Fallback to microphone only
          stream = await navigator.mediaDevices.getUserMedia({ audio: true });
          showToast('info', 'Microphone access granted. No camera detected or available.');
        } catch (audioErr) {
          console.warn('Audio-only request failed, trying video only...', audioErr);
          try {
            // Fallback to camera only
            stream = await navigator.mediaDevices.getUserMedia({ video: true });
            showToast('info', 'Camera access granted. No microphone detected or available.');
          } catch (videoErr) {
            throw new Error('Both audio and video devices are unavailable or permission was denied.');
          }
        }
      }
      if (stream) {
        stream.getTracks().forEach(track => track.stop());
      }
    } else {
      showToast('error', 'Insecure context detected! Browsers block Camera/Mic on HTTP. Please use HTTPS or localhost to enable permissions.');
    }
  } catch (err) {
    console.warn('Permissions rejected or failed:', err);
    showToast('error', 'Media access failed: ' + err.message);
  }
}

// --- TEAM CHAT CONTROLLERS ---
async function loadChatContacts() {
  const listContainer = document.getElementById('chat-contacts-list');
  if (!listContainer) return;
  
  listContainer.innerHTML = '<div style="color: var(--text-secondary); text-align: center; margin-top: 20px; font-size: 13px;">Loading contacts...</div>';
  
  try {
    const res = await fetch(`${API_URL}/api/chat/users`, { headers: getHeaders() });
    
    if (!res.ok) {
      throw new Error(`Server returned status ${res.status}`);
    }
    
    const contentType = res.headers.get('content-type');
    if (!contentType || !contentType.includes('application/json')) {
      throw new Error('Server returned non-JSON response (likely an HTML page).');
    }
    
    allChatUsers = await safeJson(res);
    renderChatContacts(allChatUsers);
  } catch (err) {
    listContainer.innerHTML = `<div style="color: #ff4757; text-align: center; margin-top: 20px; font-size: 13px;">Failed to load contacts: ${err.message}</div>`;
  }
}

function renderChatContacts(users) {
  const listContainer = document.getElementById('chat-contacts-list');
  if (!listContainer) return;
  
  if (users.length === 0) {
    listContainer.innerHTML = '<div style="color: var(--text-secondary); text-align: center; margin-top: 40px; font-size: 13px;">No contacts found</div>';
    return;
  }
  
  listContainer.innerHTML = users.map(user => {
    const isActive = (activeChatPartnerId === user.id || activeChatGroupId === user.id);
    const isGroup = user.type === 'group';
    const initial = isGroup ? '👥' : (user.full_name ? user.full_name.charAt(0).toUpperCase() : 'U');
    const roleText = isGroup ? `${user.members ? user.members.length : 0} members` : user.role;
    const clickHandler = isGroup ? `selectChatGroup('${user.id}')` : `selectChatContact('${user.id}')`;
    const statusColor = isGroup ? '#704df4' : '#2ed573';
    
    return `
      <div onclick="${clickHandler}" data-id="${user.id}" style="display: flex; align-items: center; gap: 12px; padding: 10px 12px; border-radius: 12px; cursor: pointer; transition: all 0.15s; ${isActive ? 'background: rgba(112, 77, 244, 0.15); border: 1px solid rgba(112, 77, 244, 0.3);' : 'border: 1px solid transparent;'}" onmouseover="if(!this.style.background.includes('112')) this.style.background='rgba(255,255,255,0.04)'" onmouseout="if(!(${isActive})) this.style.background=''">
        <div style="position: relative; flex-shrink: 0;">
          <div style="width: 44px; height: 44px; border-radius: 50%; background: ${isGroup ? 'linear-gradient(135deg, #704df4, #00d2ff)' : 'linear-gradient(135deg, rgba(112,77,244,0.3), rgba(0,210,255,0.3))'}; display: flex; align-items: center; justify-content: center; font-weight: 700; font-size: ${isGroup ? '20px' : '16px'}; color: #fff;">${initial}</div>
          <div style="position: absolute; bottom: 1px; right: 1px; width: 10px; height: 10px; border-radius: 50%; background: ${statusColor}; border: 2px solid rgba(8,10,18,0.9);"></div>
        </div>
        <div style="flex: 1; min-width: 0;">
          <div style="font-weight: 600; font-size: 13px; color: #fff; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${user.full_name}</div>
          <div style="font-size: 11px; color: var(--text-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-top: 2px;">${roleText}</div>
        </div>
      </div>`;
  }).join('');
}

function filterChatContacts() {
  const query = document.getElementById('chat-contact-search').value.toLowerCase();
  const filtered = allChatUsers.filter(u => {
    return u.full_name.toLowerCase().includes(query) || u.role.toLowerCase().includes(query);
  });
  renderChatContacts(filtered);
}

function selectChatContact(partnerId) {
  activeChatPartnerId = partnerId;
  activeChatGroupId = null;
  
  const partner = allChatUsers.find(u => u.id === partnerId);
  if (!partner) return;
  
  document.getElementById('chat-active-partner-name').innerText = partner.full_name;
  document.getElementById('chat-active-partner-role').innerText = partner.role;
  document.getElementById('chat-status-dot').style.background = '#2ed573';
  document.getElementById('chat-status-text').innerText = 'online';
  
  // Update avatar
  const initial = partner.full_name ? partner.full_name.charAt(0).toUpperCase() : '?';
  document.getElementById('chat-partner-avatar').innerText = initial;
  document.getElementById('chat-partner-avatar').style.background = 'linear-gradient(135deg, rgba(112,77,244,0.4), rgba(0,210,255,0.4))';
  
  document.getElementById('chat-message-input').removeAttribute('disabled');
  document.getElementById('chat-send-btn').removeAttribute('disabled');
  document.getElementById('chat-message-input').focus();
  
  // Reset form handler to individual chat
  document.getElementById('chat-input-form').onsubmit = handleSendChatMessage;
  
  loadChatHistory(partnerId);
  renderChatContacts(allChatUsers);
  
  if (chatPollInterval) clearInterval(chatPollInterval);
  chatPollInterval = setInterval(() => {
    if (activeChatPartnerId === partnerId) {
      loadChatHistory(partnerId);
    }
  }, 3000);
}

async function loadChatHistory(partnerId) {
  const messagesContainer = document.getElementById('chat-messages-container');
  if (!messagesContainer) return;
  
  try {
    const res = await fetch(`${API_URL}/api/chat/history/${partnerId}`, { headers: getHeaders() });
    const messages = await safeJson(res);
    
    if (messages.length === 0) {
      messagesContainer.innerHTML = `
        <div style="flex: 1; display: flex; align-items: center; justify-content: center; color: var(--text-secondary); flex-direction: column; gap: 10px; text-align: center;">
          <span style="font-size: 30px;">💬</span>
          <span style="font-size: 13px;">This is the beginning of your chat history. Say hello!</span>
        </div>
      `;
      return;
    }
    
    const atBottom = messagesContainer.scrollHeight - messagesContainer.scrollTop - messagesContainer.clientHeight < 80;
    
    messagesContainer.innerHTML = messages.map(msg => {
      const isMine = msg.sender_id === currentUser.id;
      const timeStr = new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      const attachmentHtml = msg.attachment ? renderChatAttachment(msg.attachment, isMine) : '';
      const editedTag = msg.edited ? ' <span style="font-style:italic; opacity:0.6;">(edited)</span>' : '';
      const actionsHtml = isMine ? `
        <div style="display:flex; gap:4px; margin-top:4px;">
          <button onclick="editChatMsg('${msg.id}')" style="background:none; border:none; color:rgba(255,255,255,0.4); font-size:10px; cursor:pointer; padding:0;">✏️</button>
          <button onclick="deleteChatMsg('${msg.id}')" style="background:none; border:none; color:rgba(255,71,87,0.5); font-size:10px; cursor:pointer; padding:0;">🗑️</button>
        </div>` : '';
      return `
        <div style="display: flex; justify-content: ${isMine ? 'flex-end' : 'flex-start'}; margin-bottom: 4px;">
          <div style="max-width: 70%; ${isMine ? 'background: linear-gradient(135deg, #704df4, #5a3fc0); color: #fff; border-radius: 18px 18px 4px 18px;' : 'background: rgba(255,255,255,0.08); color: #fff; border-radius: 18px 18px 18px 4px;'} padding: 10px 14px; box-shadow: 0 1px 2px rgba(0,0,0,0.2);">
            ${attachmentHtml}
            <div style="font-size: 13px; line-height: 1.4; word-wrap: break-word;">${msg.message}${editedTag}</div>
            <div style="font-size: 10px; ${isMine ? 'color: rgba(255,255,255,0.6);' : 'color: var(--text-muted);'} text-align: right; margin-top: 4px;">${timeStr}</div>
            ${actionsHtml}
          </div>
        </div>`;
    }).join('');
    
    if (atBottom || messagesContainer.innerHTML.includes('beginning of your chat')) {
      messagesContainer.scrollTop = messagesContainer.scrollHeight;
    }
  } catch (err) {
    console.warn('Error loading chat history:', err);
  }
}

async function handleSendChatMessage(e) {
  e.preventDefault();
  if (!activeChatPartnerId) return;

  const inputEl = document.getElementById('chat-message-input');
  const messageText = inputEl.value.trim();
  const fileInput = document.getElementById('chat-file-input');
  const hasFile = fileInput.files.length > 0;

  if (!messageText && !hasFile) return;

  inputEl.value = '';

  // If there's a file, upload it first then send message with file info
  if (hasFile) {
    const formData = new FormData();
    formData.append('file', fileInput.files[0]);

    try {
      const uploadRes = await fetch(`${API_URL}/api/chat/upload`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${currentToken}` },
        body: formData
      });

      if (!uploadRes.ok) throw new Error('File upload failed');
      const fileData = await uploadRes.json();

      // Send message with file info
      const finalMessage = messageText || `📎 ${fileData.name}`;
      const res = await fetch(`${API_URL}/api/chat/send`, {
        method: 'POST',
        headers: getHeaders(),
        body: JSON.stringify({
          recipient_id: activeChatPartnerId,
          message: finalMessage,
          attachment: fileData
        })
      });

      if (res.ok) {
        clearChatFile();
        loadChatHistory(activeChatPartnerId);
      } else {
        const err = await res.json();
        showToast('error', err.error || 'Failed to send message');
      }
    } catch (err) {
      showToast('error', 'Error: ' + err.message);
    }
  } else {
    // Text-only message
    try {
      const res = await fetch(`${API_URL}/api/chat/send`, {
        method: 'POST',
        headers: getHeaders(),
        body: JSON.stringify({
          recipient_id: activeChatPartnerId,
          message: messageText
        })
      });

      if (res.ok) {
        loadChatHistory(activeChatPartnerId);
      } else {
        const err = await res.json();
        showToast('error', err.error || 'Failed to send message');
      }
    } catch (err) {
      showToast('error', 'Error sending message: ' + err.message);
    }
  }
}

// --- CHAT FILE HANDLERS ---
let pendingChatFile = null;

function handleChatFileSelect(e) {
  const file = e.target.files[0];
  if (!file) return;

  pendingChatFile = file;
  const preview = document.getElementById('chat-file-preview');
  const content = document.getElementById('chat-file-preview-content');

  const isImage = file.type.startsWith('image/');
  const isVideo = file.type.startsWith('video/');
  const isAudio = file.type.startsWith('audio/');
  const sizeKB = (file.size / 1024).toFixed(1);
  const sizeMB = (file.size / (1024 * 1024)).toFixed(1);
  const sizeStr = file.size > 1024 * 1024 ? `${sizeMB} MB` : `${sizeKB} KB`;

  let icon = '📄';
  if (isImage) icon = '🖼️';
  else if (isVideo) icon = '🎬';
  else if (isAudio) icon = '🎵';
  else if (file.type === 'application/pdf') icon = '📕';
  else if (file.name.match(/\.(zip|rar)$/)) icon = '📦';

  let previewHtml = '';

  if (isImage) {
    const url = URL.createObjectURL(file);
    previewHtml = `<img src="${url}" style="width: 48px; height: 48px; border-radius: 8px; object-fit: cover; flex-shrink: 0;">`;
  } else {
    previewHtml = `<div style="width: 48px; height: 48px; border-radius: 8px; background: rgba(112,77,244,0.15); display: flex; align-items: center; justify-content: center; font-size: 22px; flex-shrink: 0;">${icon}</div>`;
  }

  content.innerHTML = `
    ${previewHtml}
    <div style="flex: 1; min-width: 0;">
      <div style="font-size: 13px; font-weight: 600; color: #fff; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${file.name}</div>
      <div style="font-size: 11px; color: var(--text-muted);">${sizeStr}</div>
    </div>
  `;
  preview.style.display = 'block';
}

function clearChatFile() {
  pendingChatFile = null;
  const fileInput = document.getElementById('chat-file-input');
  if (fileInput) fileInput.value = '';
  const preview = document.getElementById('chat-file-preview');
  if (preview) preview.style.display = 'none';
}

function renderChatAttachment(attachment, isMine) {
  if (!attachment) return '';
  const { url, name, type, size } = attachment;
  const sizeKB = (size / 1024).toFixed(1);
  const sizeMB = (size / (1024 * 1024)).toFixed(1);
  const sizeStr = size > 1024 * 1024 ? `${sizeMB} MB` : `${sizeKB} KB`;

  if (type === 'image') {
    return `<a href="${API_URL}${url}" target="_blank" style="display: block; margin-top: 6px; border-radius: 10px; overflow: hidden;"><img src="${API_URL}${url}" style="max-width: 100%; max-height: 250px; border-radius: 10px; display: block;" alt="${name}"></a>`;
  }
  if (type === 'video') {
    return `<video controls style="max-width: 100%; max-height: 250px; border-radius: 10px; margin-top: 6px; display: block;"><source src="${API_URL}${url}" type="${attachment.mime}"></video>`;
  }
  if (type === 'audio') {
    return `<audio controls style="width: 100%; margin-top: 6px; height: 36px;"><source src="${API_URL}${url}" type="${attachment.mime}"></audio>`;
  }

  // Generic file
  let icon = '📄';
  if (name.match(/\.pdf$/)) icon = '📕';
  else if (name.match(/\.(doc|docx)$/)) icon = '📝';
  else if (name.match(/\.(zip|rar)$/)) icon = '📦';
  else if (name.match(/\.(txt)$/)) icon = '📃';

  return `<a href="${API_URL}${url}" target="_blank" style="display: flex; align-items: center; gap: 8px; padding: 8px 12px; margin-top: 6px; background: rgba(255,255,255,0.06); border-radius: 10px; text-decoration: none; color: ${isMine ? '#fff' : 'var(--accent-cyan)'}; border: 1px solid rgba(255,255,255,0.08);">
    <span style="font-size: 20px;">${icon}</span>
    <div style="flex: 1; min-width: 0;">
      <div style="font-size: 12px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${name}</div>
      <div style="font-size: 10px; opacity: 0.6;">${sizeStr}</div>
    </div>
    <span style="font-size: 14px;">⬇️</span>
  </a>`;
}

// --- WEBRTC STANDALONE CALL ENGINE ---
async function startWebRTCCall(meetingId) {
  const configuration = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };
  peerConnection = new RTCPeerConnection(configuration);
  
  try {
    try {
      localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
    } catch (mediaErr) {
      console.warn('Meeting call: Dual media failed, trying audio only...', mediaErr);
      try {
        localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        showToast('info', 'Joined call with audio only.');
      } catch (audioErr) {
        console.warn('Meeting call: Audio only failed, trying video only...', audioErr);
        try {
          localStream = await navigator.mediaDevices.getUserMedia({ video: true });
          showToast('info', 'Joined call with video only.');
        } catch (videoErr) {
          throw new Error('Could not access microphone or camera. Please verify permissions.');
        }
      }
    }
    const localVideo = document.getElementById('webrtc-local-video');
    if (localVideo) localVideo.srcObject = localStream;
    
    localStream.getTracks().forEach(track => {
      peerConnection.addTrack(track, localStream);
    });
  } catch (e) {
    console.error('Camera/Mic permission failed:', e);
    showToast('error', e.message || 'Camera or microphone block. Access required for WebRTC call.');
    return;
  }

  peerConnection.onicecandidate = (event) => {
    if (event.candidate) {
      fetch(`${API_URL}/api/meetings/signal`, {
        method: 'POST',
        headers: getHeaders(),
        body: JSON.stringify({
          meetingId: meetingId,
          signalData: event.candidate,
          type: 'candidate'
        })
      }).catch(err => console.warn('ICE Candidate upload failed:', err));
    }
  };

  peerConnection.ontrack = (event) => {
    const remoteVideo = document.getElementById('webrtc-remote-video');
    if (remoteVideo) {
      remoteVideo.srcObject = event.streams[0];
    }
    const overlay = document.getElementById('webrtc-status-overlay');
    if (overlay) {
      overlay.style.opacity = '0';
      setTimeout(() => overlay.classList.add('hidden'), 500);
    }
    const statusLabel = document.getElementById('webrtc-status-label');
    if (statusLabel) statusLabel.innerText = 'Connected';
  };

  let isNegotiator = false;
  let candidatesAdded = {};

  webrtcSignalInterval = setInterval(async () => {
    try {
      const res = await fetch(`${API_URL}/api/meetings/signals/${meetingId}`, { headers: getHeaders() });
      const signals = await res.json();
      
      const peerIds = Object.keys(signals).filter(id => id !== currentUser.id);
      
      if (peerIds.length > 0) {
        const peerId = peerIds[0];
        const peerSignal = signals[peerId];
        
        if (peerSignal.offer && !peerConnection.remoteDescription) {
          isNegotiator = false;
          await peerConnection.setRemoteDescription(new RTCSessionDescription(peerSignal.offer));
          const answer = await peerConnection.createAnswer();
          await peerConnection.setLocalDescription(answer);
          
          await fetch(`${API_URL}/api/meetings/signal`, {
            method: 'POST',
            headers: getHeaders(),
            body: JSON.stringify({
              meetingId: meetingId,
              signalData: answer,
              type: 'answer'
            })
          });
        }
        
        if (isNegotiator && peerSignal.answer && !peerConnection.remoteDescription) {
          await peerConnection.setRemoteDescription(new RTCSessionDescription(peerSignal.answer));
        }
        
        if (peerSignal.candidates && peerSignal.candidates.length > 0) {
          peerSignal.candidates.forEach(async (candidate) => {
            const candidateKey = JSON.stringify(candidate);
            if (!candidatesAdded[candidateKey]) {
              candidatesAdded[candidateKey] = true;
              try {
                await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
              } catch (e) {
                console.warn('Error adding ICE candidate:', e);
              }
            }
          });
        }
      } else {
        if (!isNegotiator && !peerConnection.localDescription) {
          isNegotiator = true;
          const offer = await peerConnection.createOffer();
          await peerConnection.setLocalDescription(offer);
          
          await fetch(`${API_URL}/api/meetings/signal`, {
            method: 'POST',
            headers: getHeaders(),
            body: JSON.stringify({
              meetingId: meetingId,
              signalData: offer,
              type: 'offer'
            })
          });
          
          const statusLabel = document.getElementById('webrtc-status-label');
          if (statusLabel) statusLabel.innerText = 'Waiting for participants...';
        }
      }
    } catch (err) {
      console.warn('Signaling poll error:', err);
    }
  }, 2000);
}

function toggleWebRTCMic() {
  if (localStream) {
    const audioTrack = localStream.getAudioTracks()[0];
    if (audioTrack) {
      webrtcIsMicMuted = !webrtcIsMicMuted;
      audioTrack.enabled = !webrtcIsMicMuted;
      document.getElementById('webrtc-mic-icon').innerText = webrtcIsMicMuted ? '🔇' : '🎙️';
      showToast('info', webrtcIsMicMuted ? 'Microphone muted' : 'Microphone unmuted');
    }
  }
}

function toggleWebRTCCam() {
  if (localStream) {
    const videoTrack = localStream.getVideoTracks()[0];
    if (videoTrack) {
      webrtcIsCamOff = !webrtcIsCamOff;
      videoTrack.enabled = !webrtcIsCamOff;
      document.getElementById('webrtc-cam-icon').innerText = webrtcIsCamOff ? '🚫' : '📹';
      showToast('info', webrtcIsCamOff ? 'Camera turned off' : 'Camera turned on');
    }
  }
}

function togglePasswordVisibility(inputId, iconEl) {
  const input = document.getElementById(inputId);
  if (input) {
    if (input.type === 'password') {
      input.type = 'text';
      iconEl.innerText = '🙈';
    } else {
      input.type = 'password';
      iconEl.innerText = '👁️';
    }
  }
}

// --- FULL STACK DEVELOPER DASHBOARD ---
async function loadFsDevDashboard() {
  try {
    const res = await fetch(`${API_URL}/api/developer-tasks`, { headers: getHeaders() });
    const list = await res.json();
    if (!res.ok) throw new Error(list.error);

    const tbody = document.querySelector('#fsdev-tasks-table tbody');
    if (list.length === 0) {
      tbody.innerHTML = '<tr><td colspan="7" class="text-center">No development tasks assigned.</td></tr>';
    } else {
      tbody.innerHTML = list.map(task => `
        <tr>
          <td><strong>${task.title}</strong></td>
          <td>${(task.description || '').slice(0, 60)}${task.description && task.description.length > 60 ? '...' : ''}</td>
          <td>${task.assigned_by_name}</td>
          <td>${task.deadline || 'N/A'}</td>
          <td><span class="badge ${task.priority === 'high' ? 'badge-pending' : task.priority === 'urgent' ? 'badge-rejected' : 'badge-active'}">${task.priority}</span></td>
          <td><span class="badge ${task.status === 'completed' ? 'badge-success' : 'badge-pending'}">${task.status}</span></td>
          <td>
            ${task.status === 'pending' || task.status === 'in_progress'
              ? `<button class="btn-primary" style="padding:4px 8px; font-size:11px;" onclick="updateDevTaskStatus('${task.id}', 'in_progress')">Start</button>`
              : task.status === 'in_progress'
                ? `<button class="btn-primary" style="padding:4px 8px; font-size:11px; background:green;" onclick="updateDevTaskStatus('${task.id}', 'completed')">Complete</button>`
                : '<span style="color:green; font-size:11px;">Done</span>'}
          </td>
        </tr>
      `).join('');
    }

    // Update stats
    document.getElementById('fsdev-total-tasks').innerText = list.length;
    document.getElementById('fsdev-completed-tasks').innerText = list.filter(t => t.status === 'completed').length;
    document.getElementById('fsdev-pending-tasks').innerText = list.filter(t => t.status === 'in_progress').length;

    // Load meetings
    const meetRes = await fetch(`${API_URL}/api/meetings`, { headers: getHeaders() });
    const meetings = await meetRes.json();
    const myMeetings = meetings.filter(m => m.participants && m.participants.includes(currentUser.id));
    const meetTimeline = document.getElementById('fsdev-meetings-timeline');
    if (myMeetings.length === 0) {
      meetTimeline.innerHTML = '<p style="color:var(--text-muted);">No meetings assigned.</p>';
    } else {
      meetTimeline.innerHTML = myMeetings.slice(0, 5).map(m => `
        <div class="timeline-item" style="padding:10px; margin-bottom:8px; background:rgba(255,255,255,0.02); border-radius:8px; border-left:3px solid var(--accent-cyan);">
          <div style="font-weight:600; font-size:13px;">${m.title}</div>
          <div style="font-size:11px; color:var(--text-secondary); margin-top:4px;">${new Date(m.date_time).toLocaleString()} | ${m.status}</div>
          ${m.status === 'scheduled' ? `<button class="btn-primary" style="margin-top:6px; padding:4px 10px; font-size:11px;" onclick="joinMeetingRoom('${m.id}')">🎥 Join</button>` : ''}
        </div>
      `).join('');
    }

    // Load groups count
    const groupRes = await fetch(`${API_URL}/api/chat/groups`, { headers: getHeaders() });
    const groups = await groupRes.json();
    document.getElementById('fsdev-group-count').innerText = groups.length;

  } catch (err) {
    showToast('error', err.message);
  }
}

async function updateDevTaskStatus(id, status) {
  try {
    const res = await fetch(`${API_URL}/api/developer-tasks/${id}/status`, {
      method: 'PATCH',
      headers: getHeaders(),
      body: JSON.stringify({ status })
    });
    if (!res.ok) throw new Error('Status update failed');
    showToast('success', `Task status updated to ${status}`);
    loadFsDevDashboard();
  } catch (err) {
    showToast('error', err.message);
  }
}

async function handleFsDevSubmit(e) {
  e.preventDefault();
  const id = document.getElementById('fsdev-submit-task-id').value;
  const submission_notes = document.getElementById('fsdev-submit-notes').value;
  const submission_url = document.getElementById('fsdev-submit-url').value;

  try {
    const res = await fetch(`${API_URL}/api/developer-tasks/${id}/submit`, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify({ submission_notes, submission_url })
    });
    if (!res.ok) throw new Error('Submission failed');
    showToast('success', 'Work submitted successfully');
    document.getElementById('fsdev-submit-form').reset();
    loadFsDevDashboard();
  } catch (err) {
    showToast('error', err.message);
  }
}

// --- WEB DEVELOPER DASHBOARD ---
async function loadWebDevDashboard() {
  try {
    const res = await fetch(`${API_URL}/api/developer-tasks`, { headers: getHeaders() });
    const list = await res.json();
    if (!res.ok) throw new Error(list.error);

    const filtered = currentUser.role === 'Web Developers'
      ? list.filter(t => t.task_type === 'web' || t.task_type === 'general')
      : list;

    const tbody = document.querySelector('#webdev-tasks-table tbody');
    if (filtered.length === 0) {
      tbody.innerHTML = '<tr><td colspan="7" class="text-center">No web development tasks assigned.</td></tr>';
    } else {
      tbody.innerHTML = filtered.map(task => `
        <tr>
          <td><strong>${task.title}</strong></td>
          <td>${(task.description || '').slice(0, 60)}${task.description && task.description.length > 60 ? '...' : ''}</td>
          <td>${task.assigned_by_name}</td>
          <td>${task.deadline || 'N/A'}</td>
          <td><span class="badge ${task.priority === 'high' ? 'badge-pending' : task.priority === 'urgent' ? 'badge-rejected' : 'badge-active'}">${task.priority}</span></td>
          <td><span class="badge ${task.status === 'completed' ? 'badge-success' : 'badge-pending'}">${task.status}</span></td>
          <td>
            ${task.status === 'pending' || task.status === 'in_progress'
              ? `<button class="btn-primary" style="padding:4px 8px; font-size:11px;" onclick="updateDevTaskStatus('${task.id}', 'in_progress')">Start</button>`
              : task.status === 'in_progress'
                ? `<button class="btn-primary" style="padding:4px 8px; font-size:11px; background:green;" onclick="updateDevTaskStatus('${task.id}', 'completed')">Complete</button>`
                : '<span style="color:green; font-size:11px;">Done</span>'}
          </td>
        </tr>
      `).join('');
    }

    // Update stats
    document.getElementById('webdev-total-tasks').innerText = filtered.length;
    document.getElementById('webdev-completed-tasks').innerText = filtered.filter(t => t.status === 'completed').length;
    document.getElementById('webdev-pending-tasks').innerText = filtered.filter(t => t.status === 'in_progress').length;

    // Load meetings
    const meetRes = await fetch(`${API_URL}/api/meetings`, { headers: getHeaders() });
    const meetings = await meetRes.json();
    const myMeetings = meetings.filter(m => m.participants && m.participants.includes(currentUser.id));
    const meetTimeline = document.getElementById('webdev-meetings-timeline');
    if (myMeetings.length === 0) {
      meetTimeline.innerHTML = '<p style="color:var(--text-muted);">No meetings assigned.</p>';
    } else {
      meetTimeline.innerHTML = myMeetings.slice(0, 5).map(m => `
        <div class="timeline-item" style="padding:10px; margin-bottom:8px; background:rgba(255,255,255,0.02); border-radius:8px; border-left:3px solid var(--accent-cyan);">
          <div style="font-weight:600; font-size:13px;">${m.title}</div>
          <div style="font-size:11px; color:var(--text-secondary); margin-top:4px;">${new Date(m.date_time).toLocaleString()} | ${m.status}</div>
          ${m.status === 'scheduled' ? `<button class="btn-primary" style="margin-top:6px; padding:4px 10px; font-size:11px;" onclick="joinMeetingRoom('${m.id}')">🎥 Join</button>` : ''}
        </div>
      `).join('');
    }

    // Load groups count
    const groupRes = await fetch(`${API_URL}/api/chat/groups`, { headers: getHeaders() });
    const groups = await groupRes.json();
    document.getElementById('webdev-group-count').innerText = groups.length;

  } catch (err) {
    showToast('error', err.message);
  }
}

async function handleWebDevSubmit(e) {
  e.preventDefault();
  const id = document.getElementById('webdev-submit-task-id').value;
  const submission_notes = document.getElementById('webdev-submit-notes').value;
  const submission_url = document.getElementById('webdev-submit-url').value;

  try {
    const res = await fetch(`${API_URL}/api/developer-tasks/${id}/submit`, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify({ submission_notes, submission_url })
    });
    if (!res.ok) throw new Error('Submission failed');
    showToast('success', 'Work submitted successfully');
    document.getElementById('webdev-submit-form').reset();
    loadWebDevDashboard();
  } catch (err) {
    showToast('error', err.message);
  }
}

// 15. AI Engineer Dashboard
async function loadAiEngDashboard() {
  try {
    const res = await fetch(`${API_URL}/api/developer-tasks`, { headers: getHeaders() });
    const list = await res.json();
    if (!res.ok) throw new Error(list.error);

    const filtered = list.filter(t => t.task_type === 'ai' || t.task_type === 'general');

    const tbody = document.querySelector('#aieng-tasks-table tbody');
    if (filtered.length === 0) {
      tbody.innerHTML = '<tr><td colspan="7" class="text-center">No AI engineering tasks assigned.</td></tr>';
    } else {
      tbody.innerHTML = filtered.map(task => `
        <tr>
          <td><strong>${task.title}</strong></td>
          <td>${(task.description || '').slice(0, 60)}${task.description && task.description.length > 60 ? '...' : ''}</td>
          <td>${task.assigned_by_name}</td>
          <td>${task.deadline || 'N/A'}</td>
          <td><span class="badge ${task.priority === 'high' ? 'badge-pending' : task.priority === 'urgent' ? 'badge-rejected' : 'badge-active'}">${task.priority}</span></td>
          <td><span class="badge ${task.status === 'completed' ? 'badge-success' : 'badge-pending'}">${task.status}</span></td>
          <td>
            ${task.status === 'pending' || task.status === 'in_progress'
              ? `<button class="btn-primary" style="padding:4px 8px; font-size:11px;" onclick="updateDevTaskStatus('${task.id}', 'in_progress')">Start</button>`
              : task.status === 'in_progress'
                ? `<button class="btn-primary" style="padding:4px 8px; font-size:11px; background:green;" onclick="updateDevTaskStatus('${task.id}', 'completed')">Complete</button>`
                : '<span style="color:green; font-size:11px;">Done</span>'}
          </td>
        </tr>
      `).join('');
    }

    // Update stats
    document.getElementById('aieng-total-tasks').innerText = filtered.length;
    document.getElementById('aieng-completed-tasks').innerText = filtered.filter(t => t.status === 'completed').length;
    document.getElementById('aieng-pending-tasks').innerText = filtered.filter(t => t.status === 'in_progress').length;

    // Load meetings
    const meetRes = await fetch(`${API_URL}/api/meetings`, { headers: getHeaders() });
    const meetings = await meetRes.json();
    const myMeetings = meetings.filter(m => m.participants && m.participants.includes(currentUser.id));
    const meetTimeline = document.getElementById('aieng-meetings-timeline');
    if (myMeetings.length === 0) {
      meetTimeline.innerHTML = '<p style="color:var(--text-muted);">No meetings assigned.</p>';
    } else {
      meetTimeline.innerHTML = myMeetings.slice(0, 5).map(m => `
        <div class="timeline-item" style="padding:10px; margin-bottom:8px; background:rgba(255,255,255,0.02); border-radius:8px; border-left:3px solid var(--accent-cyan);">
          <div style="font-weight:600; font-size:13px;">${m.title}</div>
          <div style="font-size:11px; color:var(--text-secondary); margin-top:4px;">${new Date(m.date_time).toLocaleString()} | ${m.status}</div>
          ${m.status === 'scheduled' ? `<button class="btn-primary" style="margin-top:6px; padding:4px 10px; font-size:11px;" onclick="joinMeetingRoom('${m.id}')">🎥 Join</button>` : ''}
        </div>
      `).join('');
    }

    // Load groups count
    const groupRes = await fetch(`${API_URL}/api/chat/groups`, { headers: getHeaders() });
    const groups = await groupRes.json();
    document.getElementById('aieng-group-count').innerText = groups.length;

  } catch (err) {
    showToast('error', err.message);
  }
}

async function handleAiEngSubmit(e) {
  e.preventDefault();
  const id = document.getElementById('aieng-submit-task-id').value;
  const submission_notes = document.getElementById('aieng-submit-notes').value;
  const submission_url = document.getElementById('aieng-submit-url').value;

  try {
    const res = await fetch(`${API_URL}/api/developer-tasks/${id}/submit`, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify({ submission_notes, submission_url })
    });
    if (!res.ok) throw new Error('Submission failed');
    showToast('success', 'AI/ML work submitted successfully');
    document.getElementById('aieng-submit-form').reset();
    loadAiEngDashboard();
  } catch (err) {
    showToast('error', err.message);
  }
}

// --- PROJECT ASSIGNMENT FUNCTIONS ---

async function handleCreateProject(e) {
  e.preventDefault();
  const title = document.getElementById('proj-title').value;
  const description = document.getElementById('proj-description').value;
  const category = document.getElementById('proj-category').value;
  const deadline = document.getElementById('proj-deadline').value;
  const priority = document.getElementById('proj-priority').value;

  try {
    const res = await fetch(`${API_URL}/api/projects`, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify({ title, description, category, deadline, priority })
    });
    if (!res.ok) throw new Error('Failed to create project');
    showToast('success', 'Project submitted for admin review');
    document.getElementById('owner-project-form').reset();
    loadOwnerProjects();
  } catch (err) {
    showToast('error', err.message);
  }
}

async function loadOwnerProjects() {
  try {
    const res = await fetch(`${API_URL}/api/projects`, { headers: getHeaders() });
    const projects = await res.json();
    if (!res.ok) throw new Error(projects.error);

    const container = document.getElementById('owner-projects-list');
    if (projects.length === 0) {
      container.innerHTML = '<p style="color:var(--text-muted);">No projects submitted yet.</p>';
      return;
    }

    container.innerHTML = projects.map(p => {
      let statusBadge = '';
      if (p.status === 'pending_admin_review') statusBadge = '<span class="badge badge-pending">Pending Review</span>';
      else if (p.status === 'approved') statusBadge = '<span class="badge badge-success">Approved</span>';
      else if (p.status === 'rejected') statusBadge = '<span class="badge badge-rejected">Rejected</span>';
      else if (p.status === 'in_progress') statusBadge = '<span class="badge badge-active">In Progress</span>';
      else if (p.status === 'submitted') statusBadge = '<span class="badge badge-approved">Submitted</span>';
      else if (p.status === 'completed') statusBadge = '<span class="badge badge-success">Completed</span>';

      const priorityColors = { low: '#2ed573', medium: '#ff9f43', high: '#ff6b6b', urgent: '#ff4757' };

      return `
        <div style="padding: 14px; margin-bottom: 10px; background: rgba(255,255,255,0.02); border-radius: 10px; border-left: 3px solid ${priorityColors[p.priority] || '#704df4'};">
          <div style="display: flex; justify-content: space-between; align-items: flex-start;">
            <div style="flex: 1;">
              <div style="font-weight: 600; font-size: 14px; color: #fff;">${p.title}</div>
              <div style="font-size: 12px; color: var(--text-muted); margin-top: 4px;">Category: ${p.category} | Assigned to: <strong>${p.assigned_to_name}</strong></div>
              <div style="font-size: 12px; color: var(--text-secondary); margin-top: 6px; line-height: 1.5;">${(p.description || '').slice(0, 120)}${p.description && p.description.length > 120 ? '...' : ''}</div>
              ${p.admin_notes ? `<div style="font-size: 11px; color: var(--accent-cyan); margin-top: 6px;">Admin: ${p.admin_notes}</div>` : ''}
              ${p.deadline ? `<div style="font-size: 11px; color: var(--text-muted); margin-top: 4px;">Deadline: ${p.deadline} | Priority: <span style="color: ${priorityColors[p.priority]}">${p.priority.toUpperCase()}</span></div>` : ''}
            </div>
            <div>${statusBadge}</div>
          </div>
        </div>`;
    }).join('');
  } catch (err) {
    showToast('error', err.message);
  }
}

// Admin loads all projects for approval
async function loadAdminProjects() {
  try {
    const res = await fetch(`${API_URL}/api/projects`, { headers: getHeaders() });
    const projects = await res.json();
    if (!res.ok) throw new Error(projects.error);

    const tbody = document.querySelector('#admin-projects-table tbody');
    if (projects.length === 0) {
      tbody.innerHTML = '<tr><td colspan="8" class="text-center">No projects found.</td></tr>';
      return;
    }

    const priorityColors = { low: '#2ed573', medium: '#ff9f43', high: '#ff6b6b', urgent: '#ff4757' };

    tbody.innerHTML = projects.map(p => {
      let statusBadge = '';
      if (p.status === 'pending_admin_review') statusBadge = '<span class="badge badge-pending">Pending Review</span>';
      else if (p.status === 'approved') statusBadge = '<span class="badge badge-success">Approved</span>';
      else if (p.status === 'rejected') statusBadge = '<span class="badge badge-rejected">Rejected</span>';
      else if (p.status === 'in_progress') statusBadge = '<span class="badge badge-active">In Progress</span>';
      else if (p.status === 'submitted') statusBadge = '<span class="badge badge-approved">Submitted</span>';
      else if (p.status === 'completed') statusBadge = '<span class="badge badge-success">Completed</span>';

      return `
        <tr>
          <td><strong>${p.business_name}</strong></td>
          <td>${p.title}</td>
          <td style="max-width: 150px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${(p.description || '').slice(0, 60)}</td>
          <td><span class="badge badge-active">${p.category}</span></td>
          <td><span style="color: ${priorityColors[p.priority]}; font-weight: 600;">${p.priority}</span></td>
          <td>${p.assigned_by_name}</td>
          <td>${statusBadge}</td>
          <td>
            ${p.status === 'pending_admin_review'
              ? `<button class="btn-primary" style="padding:4px 8px; font-size:11px; background:green;" onclick="openProjectApproveModal('${p.id}')">Approve</button>
                 <button class="btn-secondary" style="padding:4px 8px; font-size:11px; border-color:red; color:red;" onclick="rejectProject('${p.id}')">Reject</button>`
              : `<button class="btn-secondary" style="padding:4px 8px; font-size:11px;" onclick="viewProjectDetails('${p.id}')">View</button>`}
          </td>
        </tr>`;
    }).join('');
  } catch (err) {
    showToast('error', err.message);
  }
}

async function openProjectApproveModal(projectId) {
  // Fetch available team members
  const usersRes = await fetch(`${API_URL}/api/users`, { headers: getHeaders() });
  const usersData = await usersRes.json();
  const users = Array.isArray(usersData) ? usersData : [];

  const assignTo = prompt(`Assign this project to someone. Enter their name:\n\nAvailable members:\n${users.map(u => `- ${u.full_name} (${u.role})`).join('\n')}`);

  if (!assignTo) return;

  const selectedUser = users.find(u => u.full_name.toLowerCase().includes(assignTo.toLowerCase()));
  if (!selectedUser) {
    return showToast('error', 'User not found. Please enter exact name.');
  }

  const admin_notes = prompt('Admin notes (optional):') || '';
  const deadline = prompt('Deadline (YYYY-MM-DD, optional):') || '';

  try {
    const res = await fetch(`${API_URL}/api/projects/${projectId}/approve`, {
      method: 'PATCH',
      headers: getHeaders(),
      body: JSON.stringify({ assigned_to: selectedUser.id, admin_notes, deadline })
    });
    if (!res.ok) throw new Error('Approval failed');
    showToast('success', `Project approved and assigned to ${selectedUser.full_name}`);
    loadAdminProjects();
  } catch (err) {
    showToast('error', err.message);
  }
}

async function rejectProject(projectId) {
  const admin_notes = prompt('Reason for rejection:');
  if (admin_notes === null) return;

  try {
    const res = await fetch(`${API_URL}/api/projects/${projectId}/reject`, {
      method: 'PATCH',
      headers: getHeaders(),
      body: JSON.stringify({ admin_notes })
    });
    if (!res.ok) throw new Error('Rejection failed');
    showToast('success', 'Project rejected');
    loadAdminProjects();
  } catch (err) {
    showToast('error', err.message);
  }
}

function viewProjectDetails(projectId) {
  showToast('info', 'Project details view coming soon');
}

async function loadAssignedProjects() {
  try {
    const res = await fetch(`${API_URL}/api/projects`, { headers: getHeaders() });
    const projects = await res.json();
    if (!res.ok) throw new Error(projects.error);

    const tbody = document.querySelector('#assigned-projects-table tbody');
    if (projects.length === 0) {
      tbody.innerHTML = '<tr><td colspan="8" class="text-center">No projects assigned.</td></tr>';
      return;
    }

    const priorityColors = { low: '#2ed573', medium: '#ff9f43', high: '#ff6b6b', urgent: '#ff4757' };

    tbody.innerHTML = projects.map(p => `
      <tr>
        <td><strong>${p.title}</strong></td>
        <td>${p.assigned_by_name}</td>
        <td style="max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${(p.description || '').slice(0, 80)}</td>
        <td><span class="badge badge-active">${p.category}</span></td>
        <td>${p.deadline || 'N/A'}</td>
        <td><span style="color: ${priorityColors[p.priority]}; font-weight: 600;">${p.priority}</span></td>
        <td><span class="badge ${p.status === 'completed' ? 'badge-success' : p.status === 'submitted' ? 'badge-approved' : 'badge-pending'}">${p.status}</span></td>
        <td>
          ${p.status === 'pending' || p.status === 'in_progress'
            ? `<button class="btn-primary" style="padding:4px 8px; font-size:11px;" onclick="updateProjectStatus('${p.id}', 'in_progress')">Start</button>`
            : p.status === 'in_progress'
              ? `<button class="btn-primary" style="padding:4px 8px; font-size:11px; background:#2ed573;" onclick="openProjectSubmitModal('${p.id}')">Submit</button>`
              : '<span style="color:#2ed573; font-size:11px;">Done</span>'}
        </td>
      </tr>
    `).join('');
  } catch (err) {
    showToast('error', err.message);
  }
}

async function updateProjectStatus(id, status) {
  try {
    const res = await fetch(`${API_URL}/api/projects/${id}/status`, {
      method: 'PATCH',
      headers: getHeaders(),
      body: JSON.stringify({ status })
    });
    if (!res.ok) throw new Error('Status update failed');
    showToast('success', `Project status updated to ${status}`);
    loadAssignedProjects();
  } catch (err) {
    showToast('error', err.message);
  }
}

function openProjectSubmitModal(id) {
  const notes = prompt('Describe what you completed:');
  if (!notes) return;
  const url = prompt('Submission URL (optional):') || '';

  fetch(`${API_URL}/api/projects/${id}/submit`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify({ submission_notes: notes, submission_url: url })
  }).then(res => {
    if (!res.ok) throw new Error('Submission failed');
    showToast('success', 'Project work submitted successfully');
    loadAssignedProjects();
  }).catch(err => showToast('error', err.message));
}
async function loadEmployeeMeetings(containerId) {
  try {
    const res = await fetch(`${API_URL}/api/meetings`, { headers: getHeaders() });
    const meetings = await res.json();
    if (!res.ok) throw new Error(meetings.error);

    // Filter meetings where user is a participant
    const myMeetings = meetings.filter(m =>
      (m.participants && m.participants.includes(currentUser.id)) ||
      (m.attendance && m.attendance.includes(currentUser.id))
    );

    const container = document.getElementById(containerId);
    if (!container) return;

    if (myMeetings.length === 0) {
      container.innerHTML = '<p style="color:var(--text-muted);">No meetings assigned to you yet.</p>';
      return;
    }

    container.innerHTML = myMeetings.map(meet => {
      let statusBadge = '';
      if (meet.status === 'scheduled') {
        statusBadge = '<span class="badge badge-active">Scheduled</span>';
      } else if (meet.status === 'completed') {
        statusBadge = '<span class="badge badge-success">Completed</span>';
      } else if (meet.status === 'pending_approval') {
        statusBadge = '<span class="badge badge-pending">Pending</span>';
      } else if (meet.status === 'rejected') {
        statusBadge = '<span class="badge badge-rejected">Rejected</span>';
      }

      let actionBtn = '';
      if (meet.status === 'scheduled') {
        actionBtn = `<button class="btn-primary" style="margin-top:8px; padding:5px 12px; font-size:12px; background:#704df4; border:none; cursor:pointer;" onclick="joinMeetingRoom('${meet.id}')">🎥 Join Meeting</button>`;
      }

      const participantsHtml = meet.participant_names && meet.participant_names.length > 0
        ? `<div style="font-size:12px; color:var(--text-secondary); margin-top:4px;">👥 Participants: ${meet.participant_names.join(', ')}</div>`
        : '';

      return `
        <div class="timeline-item" style="padding:15px; margin-bottom:12px; background:rgba(255,255,255,0.02); border-radius:10px; border-left:3px solid var(--accent-cyan);">
          <div style="display:flex; justify-content:space-between; align-items:flex-start;">
            <div>
              <div style="font-weight:600; font-size:14px;">${meet.title}</div>
              <div style="font-size:12px; color:var(--text-secondary); margin-top:4px;">
                Business: ${meet.business_name} | ${new Date(meet.date_time).toLocaleString()}
              </div>
              ${participantsHtml}
              ${meet.notes ? `<div style="font-size:12px; color:var(--text-secondary); margin-top:6px;"><strong>Notes:</strong> ${meet.notes}</div>` : ''}
              ${meet.follow_ups ? `<div style="font-size:12px; color:var(--text-secondary); margin-top:4px;"><strong>Actions:</strong> ${meet.follow_ups}</div>` : ''}
            </div>
            <div>${statusBadge}</div>
          </div>
          ${actionBtn}
        </div>`;
    }).join('');
  } catch (err) {
    showToast('error', err.message);
  }
}

// --- ADMIN MEETING TASKS ---
async function loadAdminMeetingTasks() {
  try {
    const res = await fetch(`${API_URL}/api/meetings/tasks`, { headers: getHeaders() });
    const list = await res.json();
    if (!res.ok) throw new Error(list.error);

    const tbody = document.querySelector('#admin-meeting-tasks-table tbody');
    const pending = list.filter(t => t.status === 'pending_admin_review');

    if (pending.length === 0) {
      tbody.innerHTML = '<tr><td colspan="7" class="text-center">No pending meeting tasks.</td></tr>';
      return;
    }

    tbody.innerHTML = pending.map(task => `
      <tr>
        <td><strong>${task.business_name}</strong></td>
        <td>${task.title}</td>
        <td>${(task.description || '').slice(0, 40)}</td>
        <td>${task.participant_names.join(', ') || 'None selected'}</td>
        <td>${task.created_by_name}</td>
        <td><span class="badge badge-pending">${task.status.replace(/_/g, ' ')}</span></td>
        <td>
          <div style="display:flex; gap:4px;">
            <button class="btn-primary" style="padding:4px 8px; font-size:11px; background:green;" onclick="approveMeetingTask('${task.id}')">Approve</button>
            <button class="btn-secondary" style="padding:4px 8px; font-size:11px; border-color:red; color:red;" onclick="rejectMeetingTask('${task.id}')">Reject</button>
          </div>
        </td>
      </tr>
    `).join('');
  } catch (err) {
    showToast('error', err.message);
  }
}

async function approveMeetingTask(id) {
  const date_time = prompt('Enter meeting date/time (YYYY-MM-DDTHH:MM):');
  if (!date_time) return;

  try {
    const res = await fetch(`${API_URL}/api/meetings/tasks/${id}/approve`, {
      method: 'PATCH',
      headers: getHeaders(),
      body: JSON.stringify({ date_time })
    });
    if (!res.ok) throw new Error('Approval failed');
    showToast('success', 'Task approved and meeting created');
    loadAdminMeetingTasks();
  } catch (err) {
    showToast('error', err.message);
  }
}

async function rejectMeetingTask(id) {
  const admin_notes = prompt('Reason for rejection:');
  if (admin_notes === null) return;

  try {
    const res = await fetch(`${API_URL}/api/meetings/tasks/${id}/reject`, {
      method: 'PATCH',
      headers: getHeaders(),
      body: JSON.stringify({ admin_notes })
    });
    if (!res.ok) throw new Error('Rejection failed');
    showToast('success', 'Task rejected');
    loadAdminMeetingTasks();
  } catch (err) {
    showToast('error', err.message);
  }
}

// --- OWNER MEETING TASKS ---
async function loadOwnerMeetingTasks() {
  try {
    const res = await fetch(`${API_URL}/api/meetings/tasks`, { headers: getHeaders() });
    const list = await res.json();
    if (!res.ok) throw new Error(list.error);

    const timeline = document.getElementById('owner-meeting-tasks-timeline');
    if (list.length === 0) {
      timeline.innerHTML = '<p style="color:var(--text-muted);">No tasks submitted yet.</p>';
      return;
    }

    timeline.innerHTML = list.map(task => `
      <div class="timeline-node">
        <div class="timeline-node-content">
          <strong>${task.title}</strong>
          <div style="font-size:12px; margin-top:4px;">Status: <span class="badge ${task.status === 'approved' ? 'badge-success' : task.status === 'rejected' ? 'badge-rejected' : 'badge-pending'}">${task.status.replace(/_/g, ' ')}</span></div>
          <div style="font-size:12px; margin-top:4px;">Participants: ${task.participant_names.join(', ') || 'None'}</div>
          ${task.admin_notes ? `<div style="font-size:12px; margin-top:4px; color:var(--text-secondary);">Admin Notes: ${task.admin_notes}</div>` : ''}
        </div>
      </div>
    `).join('');
  } catch (err) {
    showToast('error', err.message);
  }
}

async function loadOwnerMeetingParticipants() {
  try {
    const res = await fetch(`${API_URL}/api/users`, { headers: getHeaders() });
    const usersData = await res.json();
    const users = Array.isArray(usersData) ? usersData : [];

    const container = document.getElementById('mt-participants-list');
    container.innerHTML = users.map(u => `
      <div style="display:flex; align-items:center; gap:8px; padding:6px 0; border-bottom:1px solid rgba(255,255,255,0.05);">
        <input type="checkbox" class="mt-participant-check" value="${u.id}" id="mt-p-${u.id}">
        <label for="mt-p-${u.id}" style="font-size:13px;">${u.full_name} (${u.role})</label>
      </div>
    `).join('');
  } catch (err) {
    showToast('error', 'Error loading users');
  }
}

async function handleOwnerMeetingTask(e) {
  e.preventDefault();
  const title = document.getElementById('mt-title').value;
  const description = document.getElementById('mt-description').value;
  const participants = [];
  document.querySelectorAll('.mt-participant-check:checked').forEach(cb => participants.push(cb.value));

  try {
    const res = await fetch(`${API_URL}/api/meetings/tasks`, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify({ title, description, participants })
    });
    if (!res.ok) throw new Error('Submission failed');
    showToast('success', 'Task submitted for admin approval');
    document.getElementById('owner-meeting-task-form').reset();
    loadOwnerMeetingTasks();
  } catch (err) {
    showToast('error', err.message);
  }
}

// --- GROUP CHAT ---
let activeChatGroupId = null;

function openCreateGroupModal() {
  document.getElementById('create-group-modal').classList.remove('hidden');
  loadGroupMembersList();
}

function closeCreateGroupModal() {
  document.getElementById('create-group-modal').classList.add('hidden');
}

async function loadGroupMembersList() {
  try {
    const res = await fetch(`${API_URL}/api/chat/users`, { headers: getHeaders() });
    const users = await res.json();
    const individualUsers = users.filter(u => u.type === 'user');

    const container = document.getElementById('group-members-checkboxes');
    container.innerHTML = individualUsers.map(u => `
      <div style="display:flex; align-items:center; gap:8px; padding:6px 0; border-bottom:1px solid rgba(255,255,255,0.05);">
        <input type="checkbox" class="group-member-check" value="${u.id}" id="gm-${u.id}">
        <label for="gm-${u.id}" style="font-size:13px;">${u.full_name} (${u.role})</label>
      </div>
    `).join('');
  } catch (err) {
    showToast('error', 'Error loading members');
  }
}

async function handleCreateGroup(e) {
  e.preventDefault();
  const name = document.getElementById('group-name-input').value;
  const member_ids = [];
  document.querySelectorAll('.group-member-check:checked').forEach(cb => member_ids.push(cb.value));

  if (member_ids.length < 2) {
    return showToast('error', 'Select at least 2 other members (3 total with you)');
  }

  try {
    const res = await fetch(`${API_URL}/api/chat/groups/create`, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify({ name, member_ids })
    });
    if (!res.ok) {
      const data = await res.json();
      throw new Error(data.error || 'Failed to create group');
    }
    showToast('success', 'Group created successfully');
    closeCreateGroupModal();
    document.getElementById('create-group-form').reset();
    loadChatContacts();
  } catch (err) {
    showToast('error', err.message);
  }
}

async function selectChatGroup(groupId) {
  activeChatGroupId = groupId;
  activeChatPartnerId = null;

  try {
    const res = await fetch(`${API_URL}/api/chat/groups`, { headers: getHeaders() });
    const groups = await safeJson(res);
    const group = groups.find(g => g.id === groupId);
    if (!group) return;

    document.getElementById('chat-active-partner-name').innerText = group.name;
    document.getElementById('chat-active-partner-role').innerHTML = `<span style="cursor:pointer; text-decoration:underline;" onclick="showGroupMembers('${groupId}')">${group.members.length} members — tap to view</span>`;
    document.getElementById('chat-status-dot').style.background = '#704df4';
    document.getElementById('chat-status-text').innerText = 'group';
    
    // Update avatar
    document.getElementById('chat-partner-avatar').innerText = '👥';
    document.getElementById('chat-partner-avatar').style.background = 'linear-gradient(135deg, #704df4, #00d2ff)';

    document.getElementById('chat-message-input').removeAttribute('disabled');
    document.getElementById('chat-send-btn').removeAttribute('disabled');
    document.getElementById('chat-message-input').focus();

    // Update form handler for group
    document.getElementById('chat-input-form').onsubmit = handleSendGroupChatMessage;

    loadGroupChatHistory(groupId);
    renderChatContacts(allChatUsers);

    if (chatPollInterval) clearInterval(chatPollInterval);
    chatPollInterval = setInterval(() => {
      if (activeChatGroupId === groupId) loadGroupChatHistory(groupId);
    }, 3000);
  } catch (err) {
    showToast('error', err.message);
  }
}

async function loadGroupChatHistory(groupId) {
  const messagesContainer = document.getElementById('chat-messages-container');
  if (!messagesContainer) return;

  try {
    const res = await fetch(`${API_URL}/api/chat/groups/${groupId}/history`, { headers: getHeaders() });
    const messages = await safeJson(res);

    if (messages.length === 0) {
      messagesContainer.innerHTML = `
        <div style="flex:1; display:flex; align-items:center; justify-content:center; color:var(--text-secondary); flex-direction:column; gap:10px; text-align:center;">
          <span style="font-size:30px;">👥</span>
          <span style="font-size:13px;">No messages yet. Say hello to the group!</span>
        </div>`;
      return;
    }

    const atBottom = messagesContainer.scrollHeight - messagesContainer.scrollTop - messagesContainer.clientHeight < 80;

    messagesContainer.innerHTML = messages.map((msg, idx) => {
      const isMine = msg.sender_id === currentUser.id;
      const timeStr = new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      const editedTag = msg.edited ? ' <span style="font-style:italic; opacity:0.6;">(edited)</span>' : '';
      const senderName = msg.sender_name || 'Unknown';
      const senderInitial = senderName.charAt(0).toUpperCase();

      // Show avatar+name only if previous message was from different person (grouping)
      const prevMsg = idx > 0 ? messages[idx - 1] : null;
      const showSender = !prevMsg || prevMsg.sender_id !== msg.sender_id;

      const actionsHtml = isMine ? `
        <div style="display:flex; gap:4px; margin-top:4px;">
          <button onclick="editGroupMsg('${msg.group_id}','${msg.id}')" style="background:none; border:none; color:rgba(255,255,255,0.4); font-size:10px; cursor:pointer; padding:0;">✏️</button>
          <button onclick="deleteGroupMsg('${msg.group_id}','${msg.id}')" style="background:none; border:none; color:rgba(255,71,87,0.5); font-size:10px; cursor:pointer; padding:0;">🗑️</button>
        </div>` : '';

      const senderHeader = showSender ? `
        <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 4px; ${isMine ? 'justify-content: flex-end;' : ''}">
          ${!isMine ? `<div style="width:28px; height:28px; border-radius:50%; background:linear-gradient(135deg, #704df4, #00d2ff); display:flex; align-items:center; justify-content:center; font-size:12px; font-weight:700; color:#fff; flex-shrink:0;">${senderInitial}</div>` : ''}
          <span style="font-size: 12px; font-weight: 600; color: ${isMine ? 'rgba(255,255,255,0.5)' : 'var(--accent-cyan)'};">${isMine ? 'You' : senderName}</span>
          ${isMine ? `<div style="width:28px; height:28px; border-radius:50%; background:linear-gradient(135deg, #5a3fc0, #704df4); display:flex; align-items:center; justify-content:center; font-size:12px; font-weight:700; color:#fff; flex-shrink:0;">${senderInitial}</div>` : ''}
        </div>` : '';

      return `
        <div style="margin-bottom: ${showSender ? '8px' : '2px'};">
          ${senderHeader}
          <div style="display: flex; justify-content: ${isMine ? 'flex-end' : 'flex-start'};">
            <div style="max-width: 65%; ${isMine ? 'background: linear-gradient(135deg, #704df4, #5a3fc0); color: #fff; border-radius: 18px 18px 4px 18px;' : 'background: rgba(255,255,255,0.08); color: #fff; border-radius: 18px 18px 18px 4px;'} padding: 10px 14px; box-shadow: 0 1px 2px rgba(0,0,0,0.2);">
              <div style="font-size: 13px; line-height: 1.4; word-wrap: break-word;">${msg.message}${editedTag}</div>
              <div style="font-size: 10px; ${isMine ? 'color: rgba(255,255,255,0.6);' : 'color: var(--text-muted);'} text-align: right; margin-top: 4px;">${timeStr}</div>
              ${actionsHtml}
            </div>
          </div>
        </div>`;
    }).join('');

    if (atBottom) messagesContainer.scrollTop = messagesContainer.scrollHeight;
  } catch (err) {
    console.warn('Error loading group chat history:', err);
  }
}

async function handleSendGroupChatMessage(e) {
  e.preventDefault();
  if (!activeChatGroupId) return;

  const inputEl = document.getElementById('chat-message-input');
  const messageText = inputEl.value.trim();
  if (!messageText) return;
  inputEl.value = '';

  try {
    const res = await fetch(`${API_URL}/api/chat/groups/${activeChatGroupId}/send`, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify({ message: messageText })
    });
    if (res.ok) {
      loadGroupChatHistory(activeChatGroupId);
    } else {
      const err = await res.json();
      showToast('error', err.error || 'Failed to send message');
    }
  } catch (err) {
    showToast('error', 'Error sending message: ' + err.message);
  }
}

// --- GROUP CHAT EDIT/DELETE ---
async function editGroupMsg(groupId, msgId) {
  const newMsg = prompt('Edit your message:');
  if (!newMsg || !newMsg.trim()) return;
  try {
    const res = await fetch(`${API_URL}/api/chat/groups/${groupId}/messages/${msgId}`, {
      method: 'PUT',
      headers: getHeaders(),
      body: JSON.stringify({ message: newMsg.trim() })
    });
    if (res.ok) loadGroupChatHistory(groupId);
    else { const e = await res.json(); showToast('error', e.error); }
  } catch (err) { showToast('error', err.message); }
}

async function deleteGroupMsg(groupId, msgId) {
  if (!confirm('Delete this message?')) return;
  try {
    const res = await fetch(`${API_URL}/api/chat/groups/${groupId}/messages/${msgId}`, {
      method: 'DELETE',
      headers: getHeaders()
    });
    if (res.ok) loadGroupChatHistory(groupId);
    else { const e = await res.json(); showToast('error', e.error); }
  } catch (err) { showToast('error', err.message); }
}

// --- INDIVIDUAL CHAT EDIT/DELETE ---
async function editChatMsg(msgId) {
  const newMsg = prompt('Edit your message:');
  if (!newMsg || !newMsg.trim()) return;
  try {
    const res = await fetch(`${API_URL}/api/chat/messages/${msgId}`, {
      method: 'PUT',
      headers: getHeaders(),
      body: JSON.stringify({ message: newMsg.trim() })
    });
    if (res.ok && activeChatPartnerId) loadChatHistory(activeChatPartnerId);
    else { const e = await res.json(); showToast('error', e.error); }
  } catch (err) { showToast('error', err.message); }
}

async function deleteChatMsg(msgId) {
  if (!confirm('Delete this message?')) return;
  try {
    const res = await fetch(`${API_URL}/api/chat/messages/${msgId}`, {
      method: 'DELETE',
      headers: getHeaders()
    });
    if (res.ok && activeChatPartnerId) loadChatHistory(activeChatPartnerId);
    else { const e = await res.json(); showToast('error', e.error); }
  } catch (err) { showToast('error', err.message); }
}

// --- SHOW GROUP MEMBERS ---
async function showGroupMembers(groupId) {
  try {
    const res = await fetch(`${API_URL}/api/chat/groups/${groupId}/members`, { headers: getHeaders() });
    const members = await safeJson(res);
    const names = members.map(m => `${m.full_name} (${m.role})`).join('\n');
    alert(`Group Members (${members.length}):\n\n${names}`);
  } catch (err) { showToast('error', err.message); }
}

// ==================== WORKSPACE SYSTEM ====================
let activeWorkspaceId = null;
let activeChannelId = null;

async function loadWorkspaces() {
  try {
    const res = await fetch(`${API_URL}/api/workspaces`, { headers: getHeaders() });
    const workspaces = await safeJson(res);
    const grid = document.getElementById('workspaces-grid');
    if (workspaces.length === 0) {
      grid.innerHTML = '<div style="text-align:center; padding:60px; color:var(--text-muted);"><div style="font-size:40px; margin-bottom:12px;">🏢</div><div style="font-size:15px; font-weight:600; color:#fff; margin-bottom:4px;">No Workspaces Yet</div><div style="font-size:13px;">Create your first workspace to start collaborating with channels</div></div>';
      return;
    }
    grid.innerHTML = workspaces.map(w => `
      <div onclick="openWorkspace('${w.id}')" style="padding:24px; background:var(--bg-secondary); border:1px solid var(--border-color); border-radius:16px; cursor:pointer; transition:all 0.2s;" onmouseover="this.style.borderColor='rgba(112,77,244,0.4)'; this.style.transform='translateY(-2px)'" onmouseout="this.style.borderColor='var(--border-color)'; this.style.transform='none'">
        <div style="display:flex; align-items:center; gap:12px; margin-bottom:12px;">
          <div style="width:48px; height:48px; border-radius:12px; background:linear-gradient(135deg, rgba(112,77,244,0.2), rgba(0,210,255,0.2)); display:flex; align-items:center; justify-content:center; font-size:24px;">${w.icon || '🏠'}</div>
          <div>
            <div style="font-size:16px; font-weight:700; color:#fff;">${w.name}</div>
            <div style="font-size:12px; color:var(--text-muted);">by ${w.creator_name}</div>
          </div>
        </div>
        <p style="font-size:13px; color:var(--text-secondary); margin:0 0 12px; line-height:1.4;">${w.description || 'No description'}</p>
        <div style="display:flex; gap:16px; font-size:12px; color:var(--text-muted);">
          <span># ${w.channel_count || 0} channels</span>
          <span>👥 ${w.members ? w.members.length : 0} members</span>
        </div>
      </div>
    `).join('');
  } catch (err) { showToast('error', err.message); }
}

function openCreateWorkspaceModal() { document.getElementById('create-workspace-modal').classList.remove('hidden'); }
function closeCreateWorkspaceModal() { document.getElementById('create-workspace-modal').classList.add('hidden'); }

async function handleCreateWorkspace(e) {
  e.preventDefault();
  try {
    const res = await fetch(`${API_URL}/api/workspaces`, {
      method: 'POST', headers: getHeaders(),
      body: JSON.stringify({
        name: document.getElementById('ws-name-input').value,
        icon: document.getElementById('ws-icon-input').value || '🏠',
        description: document.getElementById('ws-desc-input').value
      })
    });
    if (res.ok) {
      showToast('success', 'Workspace created!');
      closeCreateWorkspaceModal();
      document.getElementById('create-workspace-form').reset();
      loadWorkspaces();
    } else { const e = await res.json(); showToast('error', e.error); }
  } catch (err) { showToast('error', err.message); }
}

async function openWorkspace(wsId) {
  activeWorkspaceId = wsId;
  activeChannelId = null;
  try {
    const res = await fetch(`${API_URL}/api/workspaces/${wsId}`, { headers: getHeaders() });
    const ws = await safeJson(res);
    document.getElementById('ws-detail-name').innerText = `${ws.icon || ''} ${ws.name}`;
    switchMainTab('workspace-detail');
    loadWsChannels(wsId);
  } catch (err) { showToast('error', err.message); }
}

async function loadWsChannels(wsId) {
  try {
    const res = await fetch(`${API_URL}/api/workspaces/${wsId}/channels`, { headers: getHeaders() });
    const channels = await safeJson(res);
    const list = document.getElementById('ws-channels-list');
    if (channels.length === 0) {
      list.innerHTML = '<div style="color:var(--text-muted); text-align:center; padding:20px; font-size:12px;">No channels yet</div>';
      return;
    }
    list.innerHTML = channels.map(ch => `
      <div onclick="selectChannel('${ch.id}')" style="padding:10px 12px; border-radius:8px; cursor:pointer; margin-bottom:4px; display:flex; align-items:center; gap:8px; transition:all 0.2s; ${activeChannelId === ch.id ? 'background:rgba(112,77,244,0.15); border:1px solid rgba(112,77,244,0.3);' : 'border:1px solid transparent;'}" onmouseover="if('${activeChannelId}'!=='${ch.id}')this.style.background='rgba(255,255,255,0.04)'" onmouseout="if('${activeChannelId}'!=='${ch.id}')this.style.background='transparent'">
        <span style="color:var(--accent-cyan); font-weight:700; font-size:14px;">#</span>
        <div style="flex:1; min-width:0;">
          <div style="font-size:13px; font-weight:600; color:#fff;">${ch.name}</div>
          ${ch.last_message ? `<div style="font-size:10px; color:var(--text-muted); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${ch.last_message.sender}: ${ch.last_message.text}</div>` : ''}
        </div>
        ${ch.message_count ? `<span style="font-size:10px; color:var(--text-muted);">${ch.message_count}</span>` : ''}
      </div>
    `).join('');
  } catch (err) { showToast('error', err.message); }
}

async function selectChannel(chId) {
  activeChannelId = chId;
  document.getElementById('ws-input-area').style.display = 'block';
  document.getElementById('ws-msg-input').focus();
  // Reload channels to highlight active
  loadWsChannels(activeWorkspaceId);
  loadChannelMessages(chId);
}

async function loadChannelMessages(chId) {
  const container = document.getElementById('ws-messages-container');
  try {
    const res = await fetch(`${API_URL}/api/workspaces/channels/${chId}/messages`, { headers: getHeaders() });
    const messages = await safeJson(res);

    // Set header
    document.getElementById('ws-channel-name').innerText = '#' + (messages.length > 0 ? '' : '');

    if (messages.length === 0) {
      container.innerHTML = '<div style="flex:1; display:flex; align-items:center; justify-content:center; flex-direction:column; gap:12px;"><div style="font-size:30px;">#</div><div style="font-size:13px; color:var(--text-muted);">No messages yet. Start the conversation!</div></div>';
      return;
    }

    container.innerHTML = messages.map((msg, idx) => {
      const isMine = msg.sender_id === currentUser.id;
      const timeStr = new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      const editedTag = msg.edited ? ' <span style="font-style:italic; opacity:0.6;">(edited)</span>' : '';
      const prevMsg = idx > 0 ? messages[idx - 1] : null;
      const showSender = !prevMsg || prevMsg.sender_id !== msg.sender_id;
      const senderInitial = (msg.sender_name || 'U').charAt(0).toUpperCase();
      const actionsHtml = isMine ? `<div style="display:flex; gap:4px; margin-top:4px;">
        <button onclick="editWsMsg('${msg.id}')" style="background:none; border:none; color:rgba(255,255,255,0.4); font-size:10px; cursor:pointer;">✏️</button>
        <button onclick="deleteWsMsg('${msg.id}')" style="background:none; border:none; color:rgba(255,71,87,0.5); font-size:10px; cursor:pointer;">🗑️</button>
      </div>` : '';

      return `<div style="margin-bottom:${showSender ? '8px' : '2px'};">
        ${showSender ? `<div style="display:flex; align-items:center; gap:8px; margin-bottom:4px;">
          <div style="width:28px; height:28px; border-radius:50%; background:linear-gradient(135deg, #704df4, #00d2ff); display:flex; align-items:center; justify-content:center; font-size:12px; font-weight:700; color:#fff;">${senderInitial}</div>
          <span style="font-size:12px; font-weight:600; color:${isMine ? 'rgba(255,255,255,0.5)' : 'var(--accent-cyan)'};">${isMine ? 'You' : msg.sender_name}</span>
        </div>` : ''}
        <div style="display:flex; justify-content:${isMine ? 'flex-end' : 'flex-start'};">
          <div style="max-width:65%; ${isMine ? 'background:linear-gradient(135deg,#704df4,#5a3fc0); color:#fff; border-radius:18px 18px 4px 18px;' : 'background:rgba(255,255,255,0.08); color:#fff; border-radius:18px 18px 18px 4px;'} padding:10px 14px;">
            <div style="font-size:13px; word-wrap:break-word;">${msg.message}${editedTag}</div>
            <div style="font-size:10px; ${isMine ? 'color:rgba(255,255,255,0.6)' : 'color:var(--text-muted)'}; text-align:right; margin-top:4px;">${timeStr}</div>
            ${actionsHtml}
          </div>
        </div>
      </div>`;
    }).join('');

    container.scrollTop = container.scrollHeight;
  } catch (err) { showToast('error', err.message); }
}

async function handleSendWsMessage(e) {
  e.preventDefault();
  if (!activeChannelId) return;
  const input = document.getElementById('ws-msg-input');
  const msg = input.value.trim();
  if (!msg) return;
  input.value = '';

  try {
    const res = await fetch(`${API_URL}/api/workspaces/channels/${activeChannelId}/messages`, {
      method: 'POST', headers: getHeaders(),
      body: JSON.stringify({ message: msg })
    });
    if (res.ok) {
      loadChannelMessages(activeChannelId);
      loadWsChannels(activeWorkspaceId);
    } else { const e = await res.json(); showToast('error', e.error); }
  } catch (err) { showToast('error', err.message); }
}

function openCreateChannelModal() { document.getElementById('create-channel-modal').classList.remove('hidden'); }
function closeCreateChannelModal() { document.getElementById('create-channel-modal').classList.add('hidden'); }

async function handleCreateChannel(e) {
  e.preventDefault();
  try {
    const res = await fetch(`${API_URL}/api/workspaces/${activeWorkspaceId}/channels`, {
      method: 'POST', headers: getHeaders(),
      body: JSON.stringify({
        name: document.getElementById('ch-name-input').value,
        description: document.getElementById('ch-desc-input').value
      })
    });
    if (res.ok) {
      showToast('success', 'Channel created!');
      closeCreateChannelModal();
      document.getElementById('create-channel-form').reset();
      loadWsChannels(activeWorkspaceId);
    } else { const e = await res.json(); showToast('error', e.error); }
  } catch (err) { showToast('error', err.message); }
}

async function editWsMsg(msgId) {
  const newMsg = prompt('Edit your message:');
  if (!newMsg || !newMsg.trim()) return;
  try {
    const res = await fetch(`${API_URL}/api/workspaces/messages/${msgId}`, {
      method: 'PUT', headers: getHeaders(),
      body: JSON.stringify({ message: newMsg.trim() })
    });
    if (res.ok) loadChannelMessages(activeChannelId);
    else { const e = await res.json(); showToast('error', e.error); }
  } catch (err) { showToast('error', err.message); }
}

async function deleteWsMsg(msgId) {
  if (!confirm('Delete this message?')) return;
  try {
    const res = await fetch(`${API_URL}/api/workspaces/messages/${msgId}`, {
      method: 'DELETE', headers: getHeaders()
    });
    if (res.ok) loadChannelMessages(activeChannelId);
    else { const e = await res.json(); showToast('error', e.error); }
  } catch (err) { showToast('error', err.message); }
}

async function showWsMembers() {
  if (!activeWorkspaceId) return;
  try {
    const res = await fetch(`${API_URL}/api/workspaces/${activeWorkspaceId}`, { headers: getHeaders() });
    const ws = await safeJson(res);
    const names = ws.member_names.map((n, i) => `${i + 1}. ${n}`).join('\n');
    alert(`Workspace Members (${ws.member_names.length}):\n\n${names}`);
  } catch (err) { showToast('error', err.message); }
}

async function showWsAddMember() {
  if (!activeWorkspaceId) return;
  try {
    const usersRes = await fetch(`${API_URL}/api/users`, { headers: getHeaders() });
    const users = await safeJson(usersRes);
    const wsRes = await fetch(`${API_URL}/api/workspaces/${activeWorkspaceId}`, { headers: getHeaders() });
    const ws = await safeJson(wsRes);
    const notMembers = users.filter(u => !ws.members.includes(u.id));
    if (notMembers.length === 0) { showToast('error', 'All users are already members'); return; }

    const names = notMembers.map(u => u.full_name).join(', ');
    const choice = prompt(`Add member (enter exact name):\n\nAvailable: ${names}`);
    if (!choice) return;
    const user = notMembers.find(u => u.full_name.toLowerCase() === choice.toLowerCase());
    if (!user) { showToast('error', 'User not found'); return; }

    const addRes = await fetch(`${API_URL}/api/workspaces/${activeWorkspaceId}/members`, {
      method: 'POST', headers: getHeaders(),
      body: JSON.stringify({ user_id: user.id })
    });
    if (addRes.ok) showToast('success', `${user.full_name} added!`);
    else { const e = await addRes.json(); showToast('error', e.error); }
  } catch (err) { showToast('error', err.message); }
}

// --- TAKE A TOUR (ROLE-BASED INTERACTIVE) ---
let currentTourStep = 0;
let tourSteps = [];

const tourData = {
  'Super Admin': [
    { icon: '👑', title: 'Welcome, Boss!', subtitle: 'Super Admin Dashboard', content: 'You are the top-level administrator with full control over the platform, all users, and all business operations.', features: ['Full platform access', 'Manage all users and roles', 'Approve/reject businesses', 'View executive audit logs'], tab: 'dashboard', highlight: '.stat-card' },
    { icon: '🏢', title: 'Business Portfolios', subtitle: 'Manage Partner Businesses', content: 'Review and approve business partner registrations. View their contracts, employees, and revenue insights.', features: ['Approve pending businesses', 'View business analytics', 'Download contract documents', 'Monitor employee rosters'], tab: 'admin-businesses', highlight: '#admin-businesses-table' },
    { icon: '🎬', title: 'Content Workflow', subtitle: 'Manage Content Pipeline', content: 'Oversee the entire content creation pipeline from raw uploads to social media publishing.', features: ['Assign tasks to editors', 'Review edited deliverables', 'Approve content for publishing', 'Track workflow status'], tab: 'admin-content', highlight: '.kanban-board' },
    { icon: '📅', title: 'Meetings & Tasks', subtitle: 'Schedule & Approve', content: 'Schedule multi-participant meetings. Approve meeting tasks submitted by business owners.', features: ['Multi-participant meetings', 'Approve/reject meeting tasks', 'Reschedule meetings', 'View meeting history'], tab: 'admin-meetings', highlight: '#admin-meetings-requests-table' },
    { icon: '✉️', title: 'Invitations', subtitle: 'Onboard New Members', content: 'Generate invitation codes and emails for new team members and business partners.', features: ['Generate invite codes', 'Send email invitations', 'Assign roles via invitations', 'Track invitation status'], tab: 'admin-invites', highlight: '#admin-invitations-list-table' },
    { icon: '🛡️', title: 'Executive Controls', subtitle: 'Audit & Security', content: 'View comprehensive audit logs, manage user statuses, and monitor all platform activity.', features: ['Executive audit logs', 'User status management', 'Activity monitoring', 'Platform security'], tab: 'boss-logs', highlight: '#boss-activity-logs-table' },
    { icon: '🎯', title: "You're All Set!", subtitle: 'Start Managing', content: 'Explore your dashboard, check pending approvals, and use the AI Voice Assistant for quick insights.', features: ['Explore the dashboard', 'Check pending approvals', 'Review content workflow', 'Use the AI Voice Assistant'], tab: 'dashboard', highlight: null }
  ],
  'Admin Team': [
    { icon: '🔧', title: 'Welcome, Admin!', subtitle: 'Admin Team Dashboard', content: 'You help manage platform operations - business approvals, content workflow, and team coordination.', features: ['Manage business portfolios', 'Handle content pipeline', 'Schedule meetings', 'Manage team invitations'], tab: 'dashboard', highlight: '.stat-card' },
    { icon: '🏢', title: 'Business Management', subtitle: 'Partner Portfolios', content: 'Review and approve business partner registrations. Monitor their progress and manage accounts.', features: ['Approve businesses', 'View business details', 'Manage contracts', 'Track employee rosters'], tab: 'admin-businesses', highlight: '#admin-businesses-table' },
    { icon: '🎬', title: 'Content Pipeline', subtitle: 'Workflow Management', content: 'Assign content tasks to editors, review submissions, and coordinate social media publishing.', features: ['Assign to video editors', 'Review deliverables', 'Approve/reject content', 'Assign to SMM'], tab: 'admin-content', highlight: '.kanban-board' },
    { icon: '📅', title: 'Meeting Management', subtitle: 'Schedule & Coordinate', content: 'Schedule meetings with multiple participants. Approve meeting requests from business owners.', features: ['Schedule meetings', 'Approve/reject requests', 'Add participants', 'View meeting history'], tab: 'admin-meetings', highlight: '#admin-meetings-requests-table' },
    { icon: '🚀', title: 'Project Approvals', subtitle: 'Review & Assign', content: 'Review project requests from Business Owners. Approve and assign them to the right team members.', features: ['Review pending projects', 'Assign to team members', 'Set deadlines', 'Track project status'], tab: 'admin-projects', highlight: '#admin-projects-table' },
    { icon: '🎯', title: "You're All Set!", subtitle: 'Start Working', content: 'Check pending approvals, review the content pipeline, and coordinate team activities.', features: ['Check pending approvals', 'Review content workflow', 'Manage team members', 'Coordinate meetings'], tab: 'dashboard', highlight: null }
  ],
  'Business Owners': [
    { icon: '💼', title: 'Welcome, Partner!', subtitle: 'Business Owner Dashboard', content: 'You are a business partner on Ascentra. Manage your business, submit content, and collaborate with the team.', features: ['Manage business profile', 'Submit content for editing', 'Create invoices', 'Request meetings'], tab: 'dashboard', highlight: '.stat-card' },
    { icon: '🏢', title: 'My Business Profile', subtitle: 'Your Business Identity', content: 'View and update your business details, industry, location, and employee information.', features: ['Update business details', 'Manage employees', 'View revenue analytics', 'Download contracts'], tab: 'owner-profile', highlight: '#prof-biz-name' },
    { icon: '🎥', title: 'Content Submission', subtitle: 'Submit Raw Content', content: 'Upload raw videos and content ideas for the team to edit and publish on social media.', features: ['Upload raw videos', 'Add content ideas', 'Track content status', 'View published results'], tab: 'owner-content', highlight: '#owner-content-form' },
    { icon: '🚀', title: 'Submit Projects', subtitle: 'Request Project Work', content: 'Submit project ideas to admin. Admin will review, approve, and assign to the right team member.', features: ['Describe project in brief', 'Set category and priority', 'Submit for admin review', 'Track approval status'], tab: 'owner-projects', highlight: '#owner-project-form' },
    { icon: '📅', title: 'Meetings & Tasks', subtitle: 'Collaborate', content: 'Request meetings with the team. Submit tasks for admin approval before scheduling.', features: ['Request meetings', 'Select participants', 'Submit meeting tasks', 'Track approval status'], tab: 'owner-meetings', highlight: '#owner-schedule-meeting-form' },
    { icon: '🧾', title: 'Invoicing', subtitle: 'Client Billing', content: 'Create professional invoices for your clients with custom branding and item details.', features: ['Create invoices', 'Custom branding', 'Track payment status', 'Print/PDF export'], tab: 'owner-invoices', highlight: '#owner-invoices-table' },
    { icon: '🎯', title: "You're All Set!", subtitle: 'Start Growing', content: 'Update your profile, submit content, create invoices, and request meetings to get started.', features: ['Update business profile', 'Submit content', 'Create invoices', 'Request meetings'], tab: 'dashboard', highlight: null }
  ],
  'Video Editors': [
    { icon: '✂️', title: 'Welcome, Editor!', subtitle: 'Video Production Desk', content: 'You create amazing video content. Access raw footage, follow editor notes, and submit finished videos.', features: ['Access raw video files', 'Download all assets', 'Submit edited work', 'Track task status'], tab: 'editor-dashboard', highlight: '#editor-tasks-table' },
    { icon: '🎬', title: 'Your Tasks', subtitle: 'Editing Workboard', content: 'View your assigned editing tasks with business details, deadlines, and raw video links.', features: ['View assigned tasks', 'Download raw videos', 'Track deadlines', 'Submit deliverables'], tab: 'editor-dashboard', highlight: '#editor-tasks-table' },
    { icon: '📦', title: 'Asset Library', subtitle: 'Stock Resources', content: 'Access shared assets including music packs, sound effects, overlays, and logo files.', features: ['Cinematic music packs', 'Transition SFX', 'Graphics overlays', 'Logo files'], tab: 'editor-dashboard', highlight: null },
    { icon: '🚀', title: 'My Projects', subtitle: 'Assigned Projects', content: 'View projects assigned to you by admin. Update status and submit completed work.', features: ['View assigned projects', 'Update project status', 'Submit completed work', 'Track deadlines'], tab: 'assigned-projects', highlight: '#assigned-projects-table' },
    { icon: '📅', title: 'My Meetings', subtitle: 'Stay Connected', content: 'View meetings you have been invited to and join scheduled video calls.', features: ['View invited meetings', 'Join Jitsi calls', 'View meeting notes', 'Track follow-ups'], tab: 'editor-meetings', highlight: null },
    { icon: '🎯', title: "You're All Set!", subtitle: 'Start Creating', content: 'Check your assigned tasks, download raw footage, and start producing amazing content!', features: ['Review assigned tasks', 'Download raw footage', 'Submit your work', 'Track completion'], tab: 'editor-dashboard', highlight: null }
  ],
  'Social Media Managers': [
    { icon: '📱', title: 'Welcome, SMM!', subtitle: 'Publishing Panel', content: 'You manage social media publishing. Receive approved videos and publish across all platforms.', features: ['Publish to TikTok', 'Post to Instagram', 'Upload to YouTube Shorts', 'Share on Facebook'], tab: 'smm-dashboard', highlight: '#smm-assets-table' },
    { icon: '🎬', title: 'Assigned Content', subtitle: 'Publishing Queue', content: 'View approved videos ready for publishing. Submit live post URLs after publishing.', features: ['View approved videos', 'Access video links', 'Submit post URLs', 'Track publish status'], tab: 'smm-dashboard', highlight: '#smm-assets-table' },
    { icon: '📅', title: 'Posting Calendar', subtitle: 'Optimal Timing', content: 'Follow the optimal posting schedule for maximum engagement across all platforms.', features: ['Morning peak: 8-10 AM', 'Afternoon peak: 1-3 PM', 'Night rush: 7-9:30 PM', 'High CTR windows'], tab: 'smm-dashboard', highlight: null },
    { icon: '🚀', title: 'My Projects', subtitle: 'Assigned Projects', content: 'View projects assigned to you by admin. Update status and submit completed work.', features: ['View assigned projects', 'Update project status', 'Submit completed work', 'Track deadlines'], tab: 'assigned-projects', highlight: '#assigned-projects-table' },
    { icon: '📅', title: 'My Meetings', subtitle: 'Stay Connected', content: 'View meetings you have been invited to and join scheduled video calls.', features: ['View invited meetings', 'Join Jitsi calls', 'View meeting notes', 'Track follow-ups'], tab: 'smm-meetings', highlight: null },
    { icon: '🎯', title: "You're All Set!", subtitle: 'Start Publishing', content: 'Check your assigned assets, publish to platforms, and submit post URLs!', features: ['Review assigned content', 'Publish to platforms', 'Submit post URLs', 'Track engagement'], tab: 'smm-dashboard', highlight: null }
  ],
  'Mentorship Members': [
    { icon: '🌱', title: 'Welcome, Mentee!', subtitle: 'Growth Center', content: 'You are on a mentorship journey. Submit requests for expert sessions and track your growth.', features: ['Request mentorship sessions', 'View advisor notes', 'Track action plans', 'Monitor progress'], tab: 'mentee-workspace', highlight: '#mentee-request-form' },
    { icon: '📝', title: 'Session Requests', subtitle: 'Get Expert Help', content: 'Submit requests for mentorship sessions with your challenges, topics, and preferred dates.', features: ['Describe challenges', 'Select discussion topics', 'Propose meeting dates', 'Track request status'], tab: 'mentee-workspace', highlight: '#mentee-request-form' },
    { icon: '📚', title: 'Advisor Sessions', subtitle: 'Learn & Grow', content: 'View your mentorship session history with advisor notes, recommendations, and action plans.', features: ['View session notes', 'Read recommendations', 'Follow action plans', 'Track progress'], tab: 'mentee-workspace', highlight: '#mentee-sessions-timeline' },
    { icon: '🚀', title: 'My Projects', subtitle: 'Assigned Projects', content: 'View projects assigned to you by admin. Update status and submit completed work.', features: ['View assigned projects', 'Update project status', 'Submit completed work', 'Track deadlines'], tab: 'assigned-projects', highlight: '#assigned-projects-table' },
    { icon: '📅', title: 'My Meetings', subtitle: 'Stay Connected', content: 'View meetings you have been invited to and join scheduled video calls.', features: ['View invited meetings', 'Join Jitsi calls', 'View meeting notes', 'Track follow-ups'], tab: 'mentee-meetings', highlight: null },
    { icon: '🎯', title: "You're All Set!", subtitle: 'Start Learning', content: 'Submit your first mentorship request and start your growth journey!', features: ['Submit session request', 'Describe your challenges', 'Track advisor feedback', 'Follow action plans'], tab: 'mentee-workspace', highlight: null }
  ],
  'Full Stack Developers': [
    { icon: '⚙️', title: 'Welcome, Developer!', subtitle: 'Full Stack Desk', content: 'You build and maintain the platform. Manage development tasks, submit work, and collaborate with the team.', features: ['View assigned tasks', 'Submit completed work', 'Track task status', 'Join team meetings'], tab: 'fsdev-dashboard', highlight: '#fsdev-tasks-table' },
    { icon: '📋', title: 'Task Manager', subtitle: 'Your Assignments', content: 'View your assigned development tasks with priorities, deadlines, and descriptions.', features: ['View task list', 'Update task status', 'Submit work with URLs', 'Track completion'], tab: 'fsdev-tasks', highlight: '#fsdev-submit-form' },
    { icon: '🚀', title: 'My Projects', subtitle: 'Assigned Projects', content: 'View projects assigned to you by admin. Update status and submit completed work.', features: ['View assigned projects', 'Update project status', 'Submit completed work', 'Track deadlines'], tab: 'assigned-projects', highlight: '#assigned-projects-table' },
    { icon: '📅', title: 'My Meetings', subtitle: 'Team Sync', content: 'View meetings you have been invited to and join scheduled video calls with the team.', features: ['View invited meetings', 'Join Jitsi calls', 'View meeting notes', 'Track follow-ups'], tab: 'fsdev-dashboard', highlight: null },
    { icon: '🎯', title: "You're All Set!", subtitle: 'Start Building', content: 'Check your assigned tasks, start development, and submit your amazing work!', features: ['Review assigned tasks', 'Start development', 'Submit your work', 'Track progress'], tab: 'fsdev-dashboard', highlight: null }
  ],
  'Web Developers': [
    { icon: '🌐', title: 'Welcome, Web Dev!', subtitle: 'Web Development Desk', content: 'You build beautiful web interfaces. Manage your web development tasks and submit completed work.', features: ['View assigned tasks', 'Submit completed work', 'Track task status', 'Join team meetings'], tab: 'webdev-dashboard', highlight: '#webdev-tasks-table' },
    { icon: '📋', title: 'Task Manager', subtitle: 'Your Assignments', content: 'View your assigned web development tasks with priorities, deadlines, and descriptions.', features: ['View task list', 'Update task status', 'Submit work with URLs', 'Track completion'], tab: 'webdev-tasks', highlight: '#webdev-submit-form' },
    { icon: '🚀', title: 'My Projects', subtitle: 'Assigned Projects', content: 'View projects assigned to you by admin. Update status and submit completed work.', features: ['View assigned projects', 'Update project status', 'Submit completed work', 'Track deadlines'], tab: 'assigned-projects', highlight: '#assigned-projects-table' },
    { icon: '📅', title: 'My Meetings', subtitle: 'Team Sync', content: 'View meetings you have been invited to and join scheduled video calls with the team.', features: ['View invited meetings', 'Join Jitsi calls', 'View meeting notes', 'Track follow-ups'], tab: 'webdev-dashboard', highlight: null },
    { icon: '🎯', title: "You're All Set!", subtitle: 'Start Building', content: 'Check your assigned tasks, start development, and submit your amazing web work!', features: ['Review assigned tasks', 'Start development', 'Submit your work', 'Track progress'], tab: 'webdev-dashboard', highlight: null }
  ],
  'AI Engineers': [
    { icon: '🤖', title: 'Welcome, AI Engineer!', subtitle: 'AI Development Desk', content: 'You build intelligent AI/ML features — model pipelines, prompt engineering, data processing, and automation across the platform.', features: ['View assigned AI tasks', 'Submit completed models', 'Track pipeline status', 'Join team meetings'], tab: 'aieng-dashboard', highlight: '#aieng-tasks-table' },
    { icon: '📋', title: 'Task Manager', subtitle: 'Your Assignments', content: 'View your assigned AI engineering tasks with priorities, deadlines, and descriptions.', features: ['View task list', 'Update task status', 'Submit work with URLs', 'Track completion'], tab: 'aieng-tasks', highlight: '#aieng-submit-form' },
    { icon: '🚀', title: 'My Projects', subtitle: 'Assigned Projects', content: 'View projects assigned to you by admin. Update status and submit completed work.', features: ['View assigned projects', 'Update project status', 'Submit completed work', 'Track deadlines'], tab: 'assigned-projects', highlight: '#assigned-projects-table' },
    { icon: '📅', title: 'My Meetings', subtitle: 'Team Sync', content: 'View meetings you have been invited to and join scheduled video calls with the team.', features: ['View invited meetings', 'Join Jitsi calls', 'View meeting notes', 'Track follow-ups'], tab: 'aieng-dashboard', highlight: null },
    { icon: '🎯', title: "You're All Set!", subtitle: 'Start Building AI', content: 'Check your assigned tasks, build AI models, and submit your amazing work!', features: ['Review assigned tasks', 'Build AI models', 'Submit your work', 'Track progress'], tab: 'aieng-dashboard', highlight: null }
  ]
};

function startRoleTour() {
  const role = currentUser.role;
  tourSteps = tourData[role] || tourData['Admin Team'];
  currentTourStep = 0;
  document.getElementById('tour-modal').classList.remove('hidden');
  renderTourStep();
  // Navigate to first step's tab
  if (tourSteps[0].tab) {
    switchMainTab(tourSteps[0].tab);
  }
}

function closeTour() {
  document.getElementById('tour-modal').classList.add('hidden');
  currentTourStep = 0;
  // Remove any highlight overlay
  const overlay = document.getElementById('tour-highlight-overlay');
  if (overlay) overlay.remove();
}

function renderTourStep() {
  const step = tourSteps[currentTourStep];
  const total = tourSteps.length;
  const isFirst = currentTourStep === 0;
  const isLast = currentTourStep === total - 1;

  document.getElementById('tour-step-icon').innerText = step.icon;
  document.getElementById('tour-step-title').innerText = step.title;
  document.getElementById('tour-step-subtitle').innerText = step.subtitle;
  document.getElementById('tour-step-content').innerText = step.content;

  const featuresHtml = step.features.map(f => `
    <div style="display: flex; align-items: center; gap: 10px; padding: 8px 12px; background: rgba(112,77,244,0.08); border-radius: 8px; border-left: 3px solid var(--accent-purple);">
      <span style="color: #2ed573; font-size: 14px;">✓</span>
      <span style="font-size: 13px; color: var(--text-secondary);">${f}</span>
    </div>
  `).join('');
  document.getElementById('tour-step-features').innerHTML = featuresHtml;

  let dotsHtml = '';
  for (let i = 0; i < total; i++) {
    const isActive = i === currentTourStep;
    const isDone = i < currentTourStep;
    dotsHtml += `<div style="width: ${isActive ? '24px' : '8px'}; height: 8px; border-radius: 4px; background: ${isActive ? 'var(--accent-purple)' : isDone ? '#2ed573' : 'rgba(255,255,255,0.15)'}; transition: all 0.3s;"></div>`;
  }
  document.getElementById('tour-progress').innerHTML = dotsHtml;

  document.getElementById('tour-prev-btn').style.display = isFirst ? 'none' : 'block';
  const nextBtn = document.getElementById('tour-next-btn');
  if (isLast) {
    nextBtn.innerText = 'Finish';
    nextBtn.style.background = 'linear-gradient(135deg, #2ed573, #17a557)';
  } else {
    nextBtn.innerText = 'Next';
    nextBtn.style.background = 'linear-gradient(135deg, #704df4, #5a3fc0)';
  }

  // Navigate to the step's tab
  if (step.tab) {
    switchMainTab(step.tab);
  }

  // Highlight the target element after a short delay
  setTimeout(() => {
    removeHighlight();
    if (step.highlight) {
      highlightElement(step.highlight);
    }
  }, 300);
}

function highlightElement(selector) {
  const el = document.querySelector(selector);
  if (!el) return;

  // Add glow effect to the element
  el.style.transition = 'box-shadow 0.3s ease';
  el.style.boxShadow = '0 0 0 3px rgba(112, 77, 244, 0.5), 0 0 20px rgba(112, 77, 244, 0.3)';
  el.style.borderRadius = '8px';
  el.setAttribute('data-tour-highlight', 'true');

  // Scroll element into view
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function removeHighlight() {
  document.querySelectorAll('[data-tour-highlight]').forEach(el => {
    el.style.boxShadow = '';
    el.removeAttribute('data-tour-highlight');
  });
}

function tourNext() {
  if (currentTourStep < tourSteps.length - 1) {
    currentTourStep++;
    renderTourStep();
  } else {
    removeHighlight();
    closeTour();
    showToast('success', 'Tour completed! Explore your dashboard.');
  }
}

function tourPrev() {
  if (currentTourStep > 0) {
    currentTourStep--;
    renderTourStep();
  }
}

