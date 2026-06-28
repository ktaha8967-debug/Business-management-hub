// Live hosted website URL
// Jab aap isko push karein ge, to mobile APK automatic live website ke database se connect ho jaye ga.
const LIVE_BACKEND_URL = 'https://taha.mayfairmarketing.online';

const isMobileApp = window.Capacitor || 
                    window.location.protocol.startsWith('capacitor') || 
                    window.location.protocol === 'file:';

const API_URL = isMobileApp
  ? LIVE_BACKEND_URL
  : (window.location.origin.includes('localhost') ? 'http://localhost:5000' : window.location.origin);
let currentUser = null;
let currentToken = null;
let currentBusiness = null; // Stored if user is a Business Owner
let activeTab = 'dashboard';
let chartsInstance = null; // Holds the business analytics Chart.js instance

// On page load, check authentication status
window.addEventListener('DOMContentLoaded', () => {
  const savedToken = localStorage.getItem('token');
  const savedUser = localStorage.getItem('user');
  const savedBusiness = localStorage.getItem('business');

  if (savedToken && savedUser) {
    currentToken = savedToken;
    currentUser = JSON.parse(savedUser);
    if (savedBusiness) currentBusiness = JSON.parse(savedBusiness);
    initCommandShell();
  } else {
    document.getElementById('landing-page-container').classList.remove('hidden');
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

  // Find sidebar items that trigger this tabId and add active class
  const activeLink = Array.from(document.querySelectorAll('.nav-item')).find(item => {
    return item.getAttribute('onclick') && item.getAttribute('onclick').includes(tabId);
  });
  if (activeLink) activeLink.classList.add('active');

  // Change title display
  const titleMap = {
    'dashboard': 'Platform Command Dashboard',
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
    'meeting-room': 'Virtual Sync & Operations Room'
  };
  document.getElementById('header-view-title').innerText = titleMap[tabId] || 'Platform Dashboard';

  // Toggle active view panel
  document.querySelectorAll('.dashboard-view').forEach(view => {
    view.classList.remove('active');
  });
  const activeView = document.getElementById(`view-${tabId}`);
  if (activeView) activeView.classList.add('active');

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

  try {
    const response = await fetch(`${API_URL}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ full_name, email, password, role })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Registration failed');

    const msg = role === 'Mentorship Members' 
      ? 'Mentorship Account created. Awaiting admin approval to request sessions.' 
      : 'Account created! You can now log in.';
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
  document.getElementById('landing-page-container').classList.remove('hidden');
  hideAuthPanel();
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
    const users = await usersRes.json();
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
    const allUsers = await usersRes.json();
    
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
}

function closeScheduleMeetingModal() {
  document.getElementById('schedule-meeting-modal').classList.add('hidden');
}

async function handleAdminScheduleMeeting(e) {
  e.preventDefault();
  const business_id = document.getElementById('meet-biz-id').value;
  const title = document.getElementById('meet-title').value;
  const date_time = document.getElementById('meet-datetime').value;

  try {
    const res = await fetch(`${API_URL}/api/meetings`, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify({ business_id, title, date_time })
    });
    if (!res.ok) throw new Error('Schedule request failed');

    showToast('success', 'Meeting scheduled successfully');
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

// 6. Admin Invitations Loader
async function loadAdminInvitations() {
  try {
    const res = await fetch(`${API_URL}/api/invitations`, { headers: getHeaders() });
    const list = await res.json();
    if (!res.ok) throw new Error(list.error);

    const tbody = document.querySelector('#admin-invitations-list-table tbody');
    if (list.length === 0) {
      tbody.innerHTML = '<tr><td colspan="3" class="text-center">No invitation links generated.</td></tr>';
      return;
    }

    tbody.innerHTML = list.map(inv => `
      <tr>
        <td><strong>${inv.business_name}</strong></td>
        <td><code>${inv.code}</code></td>
        <td><span class="badge ${inv.is_used ? 'badge-success' : 'badge-active'}">${inv.is_used ? 'Used' : 'Active'}</span></td>
      </tr>
    `).join('');
  } catch (err) {
    showToast('error', err.message);
  }
}

async function handleGenerateInvite(e) {
  e.preventDefault();
  const business_name = document.getElementById('invite-biz-name').value;
  try {
    const res = await fetch(`${API_URL}/api/invitations/create`, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify({ business_name })
    });
    if (!res.ok) throw new Error('Error creating invite link');

    showToast('success', 'Invitation link generated');
    document.getElementById('invite-biz-name').value = '';
    loadAdminInvitations();
  } catch (err) {
    showToast('error', err.message);
  }
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

      return `
      <div class="timeline-item">
        <div class="timeline-title">${meet.title}</div>
        <div class="timeline-date">Scheduled: ${new Date(meet.date_time).toLocaleString()}</div>
        ${meet.notes ? `<div style="margin-top:10px; font-size:13px; color:var(--text-secondary);"><strong>Notes:</strong> ${meet.notes}</div>` : ''}
        ${meet.follow_ups ? `<div style="margin-top:5px; font-size:13px; color:var(--text-secondary);"><strong>Actions:</strong> ${meet.follow_ups}</div>` : ''}
        ${statusMeta}
      </div>
      `;
    }).join('');
  } catch (err) {
    showToast('error', err.message);
  }
}

async function handleOwnerScheduleMeeting(e) {
  e.preventDefault();
  const title = document.getElementById('owner-meet-title').value;
  const date_time = document.getElementById('owner-meet-datetime').value;

  try {
    const res = await fetch(`${API_URL}/api/meetings`, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify({ title, date_time })
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

async function loadNotifications() {
  try {
    const res = await fetch(`${API_URL}/api/notifications`, { headers: getHeaders() });
    const list = await res.json();
    if (!res.ok) throw new Error(list.error);

    const bellCount = document.getElementById('notification-count');
    const unread = list.filter(n => !n.is_read);
    bellCount.innerText = unread.length;

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
    utterance.rate = 1.0;
    utterance.pitch = 1.0;

    // Try to find a premium native voice if available
    const voices = window.speechSynthesis.getVoices();
    const preferredVoice = voices.find(v => v.lang.includes('en') && (v.name.includes('Google') || v.name.includes('Natural') || v.name.includes('Microsoft')));
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

function toggleSpeechRecognition() {
  const statusEl = document.getElementById('voice-agent-status');
  const recordBtn = document.getElementById('voice-record-btn');
  const transcriptPanel = document.getElementById('voice-agent-transcript');
  const transcriptText = document.getElementById('voice-transcript-text');

  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    return showToast('error', 'Web Speech API is not supported in this browser. Please try Google Chrome.');
  }

  if (isVoiceRecording) {
    if (speechRecognition) {
      speechRecognition.stop();
    }
    return;
  }

  // Cancel any ongoing speaking
  window.speechSynthesis.cancel();

  speechRecognition = new SpeechRecognition();
  speechRecognition.lang = 'en-US';
  speechRecognition.interimResults = false;
  speechRecognition.maxAlternatives = 1;

  speechRecognition.onstart = () => {
    isVoiceRecording = true;
    statusEl.innerText = 'Status: Listening... Speak clear and close to microphone';
    recordBtn.innerText = '🛑 Stop Recording';
    recordBtn.style.background = 'red';
  };

  speechRecognition.onerror = (e) => {
    statusEl.innerText = `Status: Microphone error (${e.error})`;
    isVoiceRecording = false;
    recordBtn.innerText = '🎤 Tap to Talk';
    recordBtn.style.background = '';
  };

  speechRecognition.onend = () => {
    isVoiceRecording = false;
    recordBtn.innerText = '🎤 Tap to Talk';
    recordBtn.style.background = '';
    if (statusEl.innerText.includes('Listening')) {
      statusEl.innerText = 'Status: Ready';
    }
  };

  speechRecognition.onresult = (event) => {
    const resultText = event.results[0][0].transcript;
    transcriptPanel.classList.remove('hidden');
    transcriptText.innerText = resultText;
    
    // Trigger custom AI Voice Agent briefing with user query
    triggerVoiceBriefing(resultText);
  };

  speechRecognition.start();
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
    const users = await res.json();
    if (!res.ok) throw new Error(users.error);

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
  document.getElementById('meet-room-live-transcript').innerText = 'Starting transcription... Say something to transcribe.';

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
    document.getElementById('meet-room-live-transcript').innerText = displayText || 'Listening...';
    
    const transcriptEl = document.getElementById('meet-room-live-transcript');
    transcriptEl.scrollTop = transcriptEl.scrollHeight;
  };

  meetingSpeechRecognition.onerror = (e) => {
    console.error('Speech recognition error in meeting room:', e.error);
    if (e.error === 'no-speech') {
      return;
    }
    document.getElementById('meet-copilot-status').innerText = `🎙️ AI Copilot: Error (${e.error})`;
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
    document.getElementById('meet-room-live-transcript').innerText = `[Demo Transcript]: ${transcript}`;
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
  switchMainTab('meeting-room');

  try {
    const res = await fetch(`${API_URL}/api/meetings`, { headers: getHeaders() });
    const list = await res.json();
    const meeting = list.find(m => m.id === meetingId);
    if (!meeting) return showToast('error', 'Meeting details not found');

    document.getElementById('meet-room-title').innerText = `🎥 Secure Meeting Room: ${meeting.title}`;
    document.getElementById('meet-room-subtitle').innerText = `Business Portfolio: ${meeting.business_name} | Date: ${new Date(meeting.date_time).toLocaleString()}`;
    document.getElementById('meet-room-notes').value = meeting.notes || '';
    document.getElementById('meet-room-followups').value = meeting.follow_ups || '';

    // Generate room name from meeting ID
    const roomName = `Ascentra-Meeting-${meeting.id}`;
    const container = document.getElementById('jitsi-meet-container');
    container.innerHTML = ''; // Clear prior iframe/contents

    // Jitsi Meet External API configurations to override Jitsi watermarks and redirect pages
    const domain = 'meet.jit.si';
    const options = {
      roomName: roomName,
      width: '100%',
      height: '100%',
      parentNode: container,
      userInfo: {
        displayName: currentUser.full_name
      },
      configOverwrite: {
        disableDeepLinking: true,
        enableClosePage: false, // Disables the post-call "thank you / powered by jitsi" redirect screen!
        enableWelcomePage: false,
        prejoinPageEnabled: false,
        disableThirdPartyRequests: true,
        branding: {
          visible: false
        }
      },
      interfaceConfigOverwrite: {
        SHOW_JITSI_WATERMARK: false,
        SHOW_BRAND_WATERMARK: false,
        SHOW_POWERED_BY: false,
        JITSI_WATERMARK_LINK: '',
        BRAND_WATERMARK_LINK: ''
      }
    };

    let localParticipantJoined = false;

    if (typeof JitsiMeetExternalAPI !== 'undefined') {
      jitsiAPIInstance = new JitsiMeetExternalAPI(domain, options);
      
      // Mark as joined once connection is established
      jitsiAPIInstance.addEventListener('videoConferenceJoined', () => {
        localParticipantJoined = true;
        showToast('info', 'Secure connection established. Call active.');
      });

      // Auto-exit and generate AI minutes if user hangs up call from within the meeting frame UI
      jitsiAPIInstance.addEventListener('videoConferenceLeft', () => {
        if (localParticipantJoined) {
          showToast('info', 'Call hung up. Syncing final AI minutes...');
          triggerAIMeetingSummarization();
          exitMeetingRoom(true);
        } else {
          showToast('warning', 'Jitsi connection failed or microphone blocked. Notes mode active.');
          // Do not exitMeetingRoom so they can still type notes or exit manually
        }
      });

      // Handle direct tab close or lifecycle cleanup
      jitsiAPIInstance.addEventListener('readyToClose', () => {
        exitMeetingRoom(true);
      });
    } else {
      // Direct iframe fallback
      container.innerHTML = `
        <iframe src="https://meet.jit.si/${roomName}#userInfo.displayName=&quot;${encodeURIComponent(currentUser.full_name)}&quot;&config.enableClosePage=false&config.disableDeepLinking=true&interfaceConfig.SHOW_POWERED_BY=false" 
                allow="camera; microphone; fullscreen; display-capture; autoplay" 
                style="border:0; width:100%; height:100%;">
        </iframe>
      `;
    }

    showToast('success', 'Entered secure virtual meeting room');
    startMeetingRoomTranscription();
  } catch (err) {
    showToast('error', 'Failed to load meeting room: ' + err.message);
  }
}

function exitMeetingRoom(skipConfirm = false) {
  if (skipConfirm || confirm('Are you sure you want to leave the virtual meeting room?')) {
    stopMeetingRoomTranscription();
    
    if (jitsiAPIInstance) {
      try {
        jitsiAPIInstance.dispose();
      } catch (e) {
        console.error('Error disposing Jitsi instance:', e);
      }
      jitsiAPIInstance = null;
    }
    
    document.getElementById('jitsi-meet-container').innerHTML = '';
    currentMeetingRoomId = null;
    showToast('info', 'Left meeting room');
    switchMainTab('dashboard');
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
    console.warn('Push notifications are not supported in this environment.');
    return;
  }

  try {
    // Register service worker
    const registration = await navigator.serviceWorker.register('service-worker.js');
    console.log('Service Worker registered:', registration.scope);

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
    console.error('Error establishing push subscription:', err);
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
