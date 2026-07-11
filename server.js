require('dotenv').config();
const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const db = require('./database');
const webpush = require('web-push');
const nodemailer = require('nodemailer');
const pdfParse = require('pdf-parse');

// Initialize Web Push VAPID keys
let vapidKeys = db.findOne('vapid_keys', () => true);
if (!vapidKeys) {
  const keys = webpush.generateVAPIDKeys();
  vapidKeys = db.insert('vapid_keys', {
    publicKey: keys.publicKey,
    privateKey: keys.privateKey
  });
}
webpush.setVapidDetails(
  'mailto:admin@ascentra.com',
  vapidKeys.publicKey,
  vapidKeys.privateKey
);

const app = express();
const PORT = process.env.PORT || 5000;
const JWT_SECRET = 'ascentra_super_secret_key_2026';

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Setup file uploads directory
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir);
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    cb(null, `${Date.now()}-${file.originalname}`);
  }
});
const upload = multer({ storage });

// Serve uploaded files statically
app.use('/uploads', express.static(uploadDir));

// --- MIDDLEWARES ---
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Access token required' });

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: 'Invalid or expired token' });
    req.user = db.findOne('users', u => u.id === user.id);
    if (!req.user) return res.status(404).json({ error: 'User not found' });
    next();
  });
}

function authorizeRoles(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Unauthorized access for this role' });
    }
    next();
  };
}

// --- AUTHENTICATION ROUTES ---

// General Register (Video Editor, Social Media Manager, Mentorship Member)
app.post('/api/auth/register', (req, res) => {
  try {
    const { full_name, email, password, role, invite_code } = req.body;
    if (!full_name || !email || !password || !role) {
      return res.status(400).json({ error: 'All fields are required' });
    }

    const existingUser = db.findOne('users', u => u.email === email);
    if (existingUser) return res.status(400).json({ error: 'Email already registered' });

    let finalRole = role;
    let autoApprove = false;

    if (invite_code) {
      const invitation = db.findOne('invitations', inv => inv.code === invite_code && !inv.is_used);
      if (!invitation) {
        return res.status(400).json({ error: 'Invalid or already used invitation code' });
      }
      
      // Mark invitation as used
      db.update('invitations', invitation.id, { is_used: true });
      
      // Override role from invitation
      if (invitation.role) {
        finalRole = invitation.role;
      }
      autoApprove = true; // Auto approved since invited by admin
    }

    // Hash password
    const password_hash = bcrypt.hashSync(password, 10);

    const newUser = db.insert('users', {
      full_name,
      email,
      password_hash,
      role: finalRole,
      status: autoApprove ? 'approved' : (finalRole === 'Mentorship Members' ? 'pending' : 'approved')
    });

    res.status(201).json({ message: 'User registered successfully', userId: newUser.id });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Business Owner Register via Invitation
app.post('/api/auth/register-owner', upload.single('document'), (req, res) => {
  try {
    const { invite_code, full_name, email, password, business_name, industry, location, description, employee_count } = req.body;
    
    if (!invite_code || !full_name || !email || !password || !business_name) {
      return res.status(400).json({ error: 'Missing required registration details' });
    }

    // Verify invitation
    const invitation = db.findOne('invitations', inv => inv.code === invite_code && !inv.is_used);
    if (!invitation) {
      return res.status(400).json({ error: 'Invalid or already used invitation code' });
    }

    const existingUser = db.findOne('users', u => u.email === email);
    if (existingUser) return res.status(400).json({ error: 'Email already registered' });

    // Mark invitation as used
    db.update('invitations', invitation.id, { is_used: true });

    // Create User (pending approval)
    const password_hash = bcrypt.hashSync(password, 10);
    const user = db.insert('users', {
      full_name,
      email,
      password_hash,
      role: 'Business Owners',
      status: 'pending' // waits for Super Admin / Admin approval
    });

    // Create Business Profile (pending approval)
    const documentPath = req.file ? `/uploads/${req.file.filename}` : '';
    const business = db.insert('businesses', {
      owner_id: user.id,
      business_name,
      industry: industry || 'Other',
      location: location || 'N/A',
      description: description || '',
      employee_count: parseInt(employee_count || 1),
      contracts: documentPath ? [documentPath] : [],
      status: 'pending', // waits for approval before accessing platform
      revenue_insights: [
        { month: 'Jan', revenue: 15000, profit: 5000 },
        { month: 'Feb', revenue: 18000, profit: 6000 },
        { month: 'Mar', revenue: 22000, profit: 8000 }
      ],
      active_projects: [],
      current_orders: []
    });

    db.logActivity(user.id, 'business_signup', `Signed up business: ${business_name} with invite code: ${invite_code}`);

    res.status(201).json({
      message: 'Registration successful! Your profile is pending review and approval.',
      userId: user.id
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Login Route
app.post('/api/auth/login', (req, res) => {
  try {
    const { email, password } = req.body;
    const user = db.findOne('users', u => u.email === email);
    if (!user) return res.status(400).json({ error: 'Invalid credentials' });

    const match = bcrypt.compareSync(password, user.password_hash);
    if (!match) return res.status(400).json({ error: 'Invalid credentials' });

    if (user.status === 'pending') {
      return res.status(403).json({ error: 'Your account is pending admin approval' });
    }

    const token = jwt.sign({ id: user.id, role: user.role }, JWT_SECRET, { expiresIn: '24h' });

    // Fetch related business if Business Owner
    let business = null;
    if (user.role === 'Business Owners') {
      business = db.findOne('businesses', b => b.owner_id === user.id);
    }

    db.logActivity(user.id, 'login', `User logged in`);

    res.json({
      token,
      user: {
        id: user.id,
        full_name: user.full_name,
        email: user.email,
        role: user.role,
        status: user.status
      },
      business
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// --- INVITATION ROUTES ---

// --- INVITATION HELPERS ---

function generateDefaultEmailBody(role, businessName, code) {
  return `Subject: Welcome to Ascentra - Invitation to Join Platform

Dear Partner,

We are delighted to invite you to join the Ascentra platform as a ${role} representing ${businessName}.

You have signed a contract agreement with us. This is our unified platform to manage operations, tasks, schedules, and start-up operations in one central place. Please register your account to join us on the platform using the details below:

Invitation Code: ${code}

Registration Link: https://taha.mayfairmarketing.online (Please select the appropriate registration tab for your role)

We look forward to working closely with you.

Best regards,
Ascentra Operations Team
admin@ascentra.com`;
}

// Create Invitation (Admin Only)
app.post('/api/invitations/create', authenticateToken, authorizeRoles('Super Admin', 'Admin Team'), upload.single('contract'), async (req, res) => {
  try {
    const { business_name, email, role } = req.body;
    if (!email || !role) {
      return res.status(400).json({ error: 'Email and role are required' });
    }
    if (!business_name) {
      return res.status(400).json({ error: 'Business name is required' });
    }

    const targetBizName = business_name;
    const cleanBizName = targetBizName.replace(/[^a-zA-Z0-9]/g, '-').replace(/\s+/g, '-').toUpperCase();
    const code = `INV-${cleanBizName}-${Math.floor(1000 + Math.random() * 9000)}`;

    let contract_path = '';
    if (req.file) {
      contract_path = `/uploads/${req.file.filename}`;
    }

    // Set the email body using the enhanced default template directly!
    const email_body = generateDefaultEmailBody(role, targetBizName, code);

    const invite = db.insert('invitations', {
      code,
      business_name: targetBizName,
      email,
      role,
      contract_path,
      email_body,
      is_used: false
    });

    db.logActivity(req.user.id, 'create_invitation', `Generated invitation email & code ${code} for ${email} as ${role}`);
    
    // Parse subject and body out of the generated email text
    let subject = `Welcome to Ascentra Hub - Platform Invitation`;
    let bodyText = email_body;
    if (email_body.startsWith('Subject:')) {
      const lines = email_body.split('\n');
      subject = lines[0].replace('Subject:', '').trim();
      bodyText = lines.slice(1).join('\n').trim();
    }

    // Fire email sending asynchronously so it doesn't block the HTTP response
    sendGmailEmail(email, subject, bodyText);

    res.status(201).json(invite);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

async function sendGmailEmail(to, subject, text) {
  const user = (process.env.SMTP_USER || '').trim();
  const pass = (process.env.SMTP_PASS || '').trim();

  if (!user || !pass) {
    console.log(`[SMTP Simulation] No SMTP credentials found in .env. Mock sent email to ${to}`);
    return false;
  }

  try {
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: user,
        pass: pass
      }
    });

    await transporter.sendMail({
      from: `"Ascentra Operations" <${user}>`,
      to: to,
      subject: subject,
      text: text
    });
    console.log(`[SMTP] Real Gmail email sent to ${to}`);
    return true;
  } catch (error) {
    console.error('[SMTP Error] Failed to send email via Gmail:', error.message);
    return false;
  }
}

// Get Invitation List
app.get('/api/invitations', authenticateToken, authorizeRoles('Super Admin', 'Admin Team'), (req, res) => {
  res.json(db.getCollection('invitations'));
});

// --- BUSINESS PROFILE ROUTES ---

// Get all businesses (Admin Only)
app.get('/api/businesses', authenticateToken, authorizeRoles('Super Admin', 'Admin Team'), (req, res) => {
  try {
    const list = db.getCollection('businesses').map(b => {
      const owner = db.findOne('users', u => u.id === b.owner_id);
      return { ...b, owner_name: owner ? owner.full_name : 'Unknown' };
    });
    res.json(list);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get My Business Profile
app.get('/api/businesses/my', authenticateToken, authorizeRoles('Business Owners'), (req, res) => {
  const business = db.findOne('businesses', b => b.owner_id === req.user.id);
  if (!business) return res.status(404).json({ error: 'Business profile not found' });
  res.json(business);
});

// Approve Business Profile
app.post('/api/businesses/:id/approve', authenticateToken, authorizeRoles('Super Admin', 'Admin Team'), (req, res) => {
  try {
    const bus = db.findOne('businesses', b => b.id === req.params.id);
    if (!bus) return res.status(404).json({ error: 'Business not found' });

    db.update('businesses', bus.id, { status: 'approved' });
    db.update('users', bus.owner_id, { status: 'approved' });

    db.sendNotification(bus.owner_id, 'Account Approved', 'Your business profile has been approved! Welcome to the platform.');
    db.logActivity(req.user.id, 'approve_business', `Approved business ${bus.business_name}`);

    res.json({ message: 'Business profile and owner account approved' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Update My Business Details
app.put('/api/businesses/my', authenticateToken, authorizeRoles('Business Owners'), (req, res) => {
  try {
    const bus = db.findOne('businesses', b => b.owner_id === req.user.id);
    if (!bus) return res.status(404).json({ error: 'Business profile not found' });

    const updated = db.update('businesses', bus.id, req.body);
    res.json(updated);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// --- DAILY PROGRESS REPORTS ---

// Submit Daily Report
app.post('/api/reports/daily', authenticateToken, authorizeRoles('Business Owners'), (req, res) => {
  try {
    const { activities, active_projects, progress, challenges, goals, updates } = req.body;
    const bus = db.findOne('businesses', b => b.owner_id === req.user.id);
    if (!bus) return res.status(404).json({ error: 'Business profile not found' });

    const newReport = db.insert('daily_reports', {
      business_id: bus.id,
      reporter_id: req.user.id,
      business_name: bus.business_name,
      activities,
      active_projects,
      progress,
      challenges,
      goals,
      updates,
      date: new Date().toISOString().split('T')[0]
    });

    db.logActivity(req.user.id, 'submit_daily_report', `Submitted daily report for ${bus.business_name}`);
    res.status(201).json(newReport);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get Daily Reports
app.get('/api/reports', authenticateToken, (req, res) => {
  try {
    if (req.user.role === 'Business Owners') {
      const bus = db.findOne('businesses', b => b.owner_id === req.user.id);
      if (!bus) return res.status(404).json({ error: 'Business profile not found' });
      res.json(db.find('daily_reports', r => r.business_id === bus.id));
    } else if (['Super Admin', 'Admin Team'].includes(req.user.role)) {
      res.json(db.getCollection('daily_reports'));
    } else {
      res.status(403).json({ error: 'Unauthorized access to reports' });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// --- CONTENT PRODUCTION WORKFLOW ROUTES ---

// Business Owner uploads raw videos / idea (supports bulk video uploads)
app.post('/api/content/submit', authenticateToken, authorizeRoles('Business Owners'), upload.array('raw_videos', 10), (req, res) => {
  try {
    const { content_idea, instructions } = req.body;
    const bus = db.findOne('businesses', b => b.owner_id === req.user.id);
    if (!bus) return res.status(404).json({ error: 'Business profile not found' });

    const raw_video_urls = req.files ? req.files.map(f => `/uploads/${f.filename}`) : [];
    const raw_video_url = raw_video_urls.length > 0 ? raw_video_urls[0] : '';

    const item = db.insert('content_items', {
      business_id: bus.id,
      business_name: bus.business_name,
      owner_id: req.user.id,
      raw_video_url, // fallback compatibility
      raw_video_urls, // array of all uploaded videos
      content_idea,
      instructions,
      status: 'pending_admin_review',
      assigned_editor_id: null,
      assigned_sm_manager_id: null,
      history: [{ status: 'pending_admin_review', user: req.user.full_name, timestamp: new Date().toISOString(), notes: `Raw content uploaded (${raw_video_urls.length} files)` }]
    });

    db.logActivity(req.user.id, 'content_upload', `Uploaded content: ${content_idea} with ${raw_video_urls.length} raw videos`);
    res.status(201).json(item);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// List Content Items (Admins / Owner / Editor / Social Manager)
app.get('/api/content', authenticateToken, (req, res) => {
  try {
    const allItems = db.getCollection('content_items');
    if (['Super Admin', 'Admin Team'].includes(req.user.role)) {
      res.json(allItems);
    } else if (req.user.role === 'Business Owners') {
      const bus = db.findOne('businesses', b => b.owner_id === req.user.id);
      res.json(allItems.filter(item => item.business_id === bus.id));
    } else if (req.user.role === 'Video Editors') {
      res.json(allItems.filter(item => item.assigned_editor_id === req.user.id));
    } else if (req.user.role === 'Social Media Managers') {
      res.json(allItems.filter(item => item.assigned_sm_manager_id === req.user.id));
    } else {
      res.status(403).json({ error: 'Access denied' });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Admin Review & Assign to Editor
app.post('/api/content/:id/assign-editor', authenticateToken, authorizeRoles('Super Admin', 'Admin Team'), (req, res) => {
  try {
    const { editor_id, deadline, notes } = req.body;
    const item = db.findOne('content_items', c => c.id === req.params.id);
    if (!item) return res.status(404).json({ error: 'Content item not found' });

    const editor = db.findOne('users', u => u.id === editor_id && u.role === 'Video Editors');
    if (!editor) return res.status(404).json({ error: 'Editor not found' });

    const history = [...item.history, { status: 'assigned_editor', user: req.user.full_name, timestamp: new Date().toISOString(), notes: notes || `Assigned to editor ${editor.full_name}` }];

    const updated = db.update('content_items', item.id, {
      status: 'assigned_editor',
      assigned_editor_id: editor_id,
      deadline,
      notes,
      history
    });

    db.sendNotification(editor_id, 'New Editing Assignment', `You have been assigned to edit video for ${item.business_name}. Deadline: ${deadline}`);
    db.logActivity(req.user.id, 'assign_video_editor', `Assigned content task ${item.id} to editor ${editor.full_name}`);

    res.json(updated);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Video Editor Submits Edited Content
app.post('/api/content/:id/editor-submit', authenticateToken, authorizeRoles('Video Editors'), (req, res) => {
  try {
    const { edited_video_url, editor_notes } = req.body;
    const item = db.findOne('content_items', c => c.id === req.params.id);
    if (!item) return res.status(404).json({ error: 'Content item not found' });

    const history = [...item.history, { status: 'editor_submitted', user: req.user.full_name, timestamp: new Date().toISOString(), notes: editor_notes || 'Edited video submitted' }];

    const updated = db.update('content_items', item.id, {
      status: 'editor_submitted',
      edited_video_url,
      editor_notes,
      history
    });

    // Notify admins
    db.find('users', u => ['Super Admin', 'Admin Team'].includes(u.role)).forEach(admin => {
      db.sendNotification(admin.id, 'Editor Submission', `Video editor ${req.user.full_name} submitted task for ${item.business_name}`);
    });

    db.logActivity(req.user.id, 'editor_submit_video', `Editor submitted work for content task ${item.id}`);

    res.json(updated);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Admin Approves or Recommends Revision
app.post('/api/content/:id/admin-review', authenticateToken, authorizeRoles('Super Admin', 'Admin Team'), (req, res) => {
  try {
    const { action, notes } = req.body; // action: 'approve' or 'revision'
    const item = db.findOne('content_items', c => c.id === req.params.id);
    if (!item) return res.status(404).json({ error: 'Content item not found' });

    if (action === 'approve') {
      const history = [...item.history, { status: 'approved', user: req.user.full_name, timestamp: new Date().toISOString(), notes: notes || 'Content approved by Admin' }];
      const updated = db.update('content_items', item.id, {
        status: 'approved',
        history
      });
      db.sendNotification(item.owner_id, 'Content Approved', 'Your content video has been approved by admin and is queued for publishing.');
      res.json(updated);
    } else {
      const history = [...item.history, { status: 'assigned_editor', user: req.user.full_name, timestamp: new Date().toISOString(), notes: `Revision requested: ${notes}` }];
      const updated = db.update('content_items', item.id, {
        status: 'assigned_editor',
        history
      });
      db.sendNotification(item.assigned_editor_id, 'Revision Requested', `Admin requested a revision on task for ${item.business_name}. Reason: ${notes}`);
      res.json(updated);
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Admin Assigns Approved Content to Social Media Manager
app.post('/api/content/:id/assign-sm', authenticateToken, authorizeRoles('Super Admin', 'Admin Team'), (req, res) => {
  try {
    const { sm_manager_id, notes } = req.body;
    const item = db.findOne('content_items', c => c.id === req.params.id);
    if (!item) return res.status(404).json({ error: 'Content item not found' });

    const sm = db.findOne('users', u => u.id === sm_manager_id && u.role === 'Social Media Managers');
    if (!sm) return res.status(404).json({ error: 'Social Media Manager not found' });

    const history = [...item.history, { status: 'assigned_sm_manager', user: req.user.full_name, timestamp: new Date().toISOString(), notes: notes || `Assigned to SMM ${sm.full_name}` }];

    const updated = db.update('content_items', item.id, {
      status: 'assigned_sm_manager',
      assigned_sm_manager_id: sm_manager_id,
      history
    });

    db.sendNotification(sm_manager_id, 'Publishing Task Assigned', `New approved content assigned to you for publishing. Business: ${item.business_name}`);
    db.logActivity(req.user.id, 'assign_social_media', `Assigned content task ${item.id} to SMM ${sm.full_name}`);

    res.json(updated);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Social Media Manager Submits Publishing Proof (TikTok, IG, FB, YT Shorts URLs)
app.post('/api/content/:id/sm-publish', authenticateToken, authorizeRoles('Social Media Managers'), (req, res) => {
  try {
    const { live_post_urls } = req.body; // object containing platform links e.g. { tiktok: '...', instagram: '...' }
    const item = db.findOne('content_items', c => c.id === req.params.id);
    if (!item) return res.status(404).json({ error: 'Content item not found' });

    const history = [...item.history, { status: 'published', user: req.user.full_name, timestamp: new Date().toISOString(), notes: `Live URLs submitted: ${JSON.stringify(live_post_urls)}` }];

    const updated = db.update('content_items', item.id, {
      status: 'published',
      live_post_urls,
      history
    });

    db.sendNotification(item.owner_id, 'Content Published!', `Your video has been published on social channels by ${req.user.full_name}`);
    db.logActivity(req.user.id, 'publish_social_media', `SMM published content task ${item.id}`);

    res.json(updated);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// --- INVOICE MANAGEMENT ROUTES ---

// Generate Invoice
app.post('/api/invoices', authenticateToken, authorizeRoles('Business Owners'), (req, res) => {
  try {
    const { client_name, client_email, branding_title, items, due_date } = req.body;
    if (!client_name || !items || items.length === 0) {
      return res.status(400).json({ error: 'Client details and items are required' });
    }

    const bus = db.findOne('businesses', b => b.owner_id === req.user.id);
    if (!bus) return res.status(404).json({ error: 'Business profile not found' });

    const invoice_number = `INV-${Date.now().toString().slice(-6)}`;
    const total = items.reduce((acc, curr) => acc + (parseFloat(curr.price) * parseInt(curr.quantity || 1)), 0);

    const invoice = db.insert('invoices', {
      business_id: bus.id,
      business_name: bus.business_name,
      invoice_number,
      client_name,
      client_email,
      branding_title: branding_title || bus.business_name,
      items,
      total,
      due_date,
      status: 'unpaid'
    });

    db.logActivity(req.user.id, 'create_invoice', `Generated invoice ${invoice_number} for client ${client_name}`);

    res.status(201).json(invoice);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get Invoices
app.get('/api/invoices', authenticateToken, (req, res) => {
  try {
    const allInvoices = db.getCollection('invoices');
    if (['Super Admin', 'Admin Team'].includes(req.user.role)) {
      res.json(allInvoices);
    } else if (req.user.role === 'Business Owners') {
      const bus = db.findOne('businesses', b => b.owner_id === req.user.id);
      res.json(allInvoices.filter(inv => inv.business_id === bus.id));
    } else {
      res.status(403).json({ error: 'Access denied' });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Change Invoice Payment Status
app.patch('/api/invoices/:id/status', authenticateToken, (req, res) => {
  try {
    const { status } = req.body;
    const inv = db.findOne('invoices', i => i.id === req.params.id);
    if (!inv) return res.status(404).json({ error: 'Invoice not found' });

    const updated = db.update('invoices', inv.id, { status });
    res.json(updated);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Printable HTML Invoice Layout (PDF download utility)
app.get('/api/invoices/:id/print', (req, res) => {
  const inv = db.findOne('invoices', i => i.id === req.params.id);
  if (!inv) return res.status(404).send('<h1>Invoice not found</h1>');

  const itemsRows = inv.items.map(item => `
    <tr>
      <td style="padding: 12px; border-bottom: 1px solid #ddd;">${item.name}</td>
      <td style="padding: 12px; border-bottom: 1px solid #ddd; text-align: right;">$${parseFloat(item.price).toFixed(2)}</td>
      <td style="padding: 12px; border-bottom: 1px solid #ddd; text-align: center;">${item.quantity || 1}</td>
      <td style="padding: 12px; border-bottom: 1px solid #ddd; text-align: right;">$${(parseFloat(item.price) * parseInt(item.quantity || 1)).toFixed(2)}</td>
    </tr>
  `).join('');

  res.send(`
    <html>
      <head>
        <title>Invoice ${inv.invoice_number}</title>
        <style>
          body { font-family: 'Helvetica Neue', Arial, sans-serif; color: #333; padding: 40px; line-height: 1.6; }
          .header { display: flex; justify-content: space-between; margin-bottom: 50px; }
          .company-branding { font-size: 24px; font-weight: bold; color: #5a3fc0; }
          .invoice-title { font-size: 32px; font-weight: bold; text-align: right; margin-top: 0; }
          .info-block { display: flex; justify-content: space-between; margin-bottom: 40px; }
          .billing-info { width: 45%; }
          table { width: 100%; border-collapse: collapse; margin-top: 20px; }
          th { background: #f8f9fa; padding: 12px; font-weight: bold; text-align: left; border-bottom: 2px solid #ddd; }
          .total { margin-top: 40px; text-align: right; font-size: 20px; font-weight: bold; }
          .footer { margin-top: 100px; text-align: center; color: #888; font-size: 12px; }
          .print-btn { background: #5a3fc0; color: white; padding: 10px 20px; border: none; border-radius: 5px; font-size: 16px; cursor: pointer; display: block; margin: 0 auto 30px auto; }
          @media print { .print-btn { display: none; } }
        </style>
      </head>
      <body>
        <button class="print-btn" onclick="window.print()">Print Invoice (PDF)</button>
        <div class="header">
          <div>
            <div class="company-branding">${inv.branding_title}</div>
            <div>Business Partner Platform</div>
          </div>
          <div>
            <h1 class="invoice-title">INVOICE</h1>
            <div><strong>Invoice No:</strong> ${inv.invoice_number}</div>
            <div><strong>Date:</strong> ${new Date(inv.created_at).toLocaleDateString()}</div>
            <div><strong>Due Date:</strong> ${inv.due_date ? new Date(inv.due_date).toLocaleDateString() : 'Upon Receipt'}</div>
            <div><strong>Status:</strong> <span style="color: ${inv.status === 'paid' ? 'green' : 'red'}; font-weight: bold;">${inv.status.toUpperCase()}</span></div>
          </div>
        </div>
        
        <div class="info-block">
          <div class="billing-info">
            <strong>From:</strong>
            <div>${inv.business_name}</div>
          </div>
          <div class="billing-info" style="text-align: right;">
            <strong>Bill To:</strong>
            <div>${inv.client_name}</div>
            <div>${inv.client_email}</div>
          </div>
        </div>

        <table>
          <thead>
            <tr>
              <th>Description</th>
              <th style="text-align: right;">Price</th>
              <th style="text-align: center;">Qty</th>
              <th style="text-align: right;">Total</th>
            </tr>
          </thead>
          <tbody>
            ${itemsRows}
          </tbody>
        </table>

        <div class="total">
          Total Due: $${parseFloat(inv.total).toFixed(2)}
        </div>

        <div class="footer">
          Thank you for your business. Generated through the partner platform command center.
        </div>
      </body>
    </html>
  `);
});

// --- MEETING MANAGEMENT ROUTES ---

// Schedule Meeting (Owners create pending meetings, Admins create scheduled meetings)
app.post('/api/meetings', authenticateToken, (req, res) => {
  try {
    const { business_id, title, date_time } = req.body;
    if (!title || !date_time) return res.status(400).json({ error: 'Title and Date/Time are required' });

    let finalBusinessId = business_id;
    let bName = 'Global';
    let status = 'scheduled';

    if (req.user.role === 'Business Owners') {
      const bus = db.findOne('businesses', b => b.owner_id === req.user.id);
      if (!bus) return res.status(404).json({ error: 'Business profile not found' });
      finalBusinessId = bus.id;
      bName = bus.business_name;
      status = 'pending_approval'; // Owners request meetings
    } else {
      if (business_id) {
        const bus = db.findOne('businesses', b => b.id === business_id);
        bName = bus ? bus.business_name : 'Global';
      }
    }

    const meeting = db.insert('meetings', {
      business_id: finalBusinessId,
      business_name: bName,
      title,
      date_time,
      status,
      attendance: [],
      participants: req.body.participants || [],
      participant_names: (req.body.participants || []).map(id => {
        const u = db.findOne('users', usr => usr.id === id);
        return u ? u.full_name : 'Unknown';
      }),
      notes: '',
      follow_ups: ''
    });

    // Notify business owner / admin
    if (req.user.role !== 'Business Owners' && finalBusinessId) {
      const bus = db.findOne('businesses', b => b.id === finalBusinessId);
      if (bus) db.sendNotification(bus.owner_id, 'New Meeting Scheduled', `A new weekly meeting has been scheduled: ${title} on ${date_time}`);
    } else if (req.user.role === 'Business Owners') {
      // Notify admin
      db.find('users', u => ['Super Admin', 'Admin Team'].includes(u.role)).forEach(admin => {
        db.sendNotification(admin.id, 'Meeting Request', `Business partner "${bName}" requested a meeting: ${title}`);
      });
    }

    db.logActivity(req.user.id, 'schedule_meeting', `Scheduled/requested meeting: ${title}`);
    res.status(201).json(meeting);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Approve Meeting Request (Admin Only)
app.post('/api/meetings/:id/approve', authenticateToken, authorizeRoles('Super Admin', 'Admin Team'), (req, res) => {
  try {
    const meeting = db.findOne('meetings', m => m.id === req.params.id);
    if (!meeting) return res.status(404).json({ error: 'Meeting not found' });

    const updated = db.update('meetings', meeting.id, { status: 'scheduled' });

    const bus = db.findOne('businesses', b => b.id === meeting.business_id);
    if (bus) db.sendNotification(bus.owner_id, 'Meeting Request Approved', `Your meeting request "${meeting.title}" has been approved for ${meeting.date_time}`);

    db.logActivity(req.user.id, 'approve_meeting', `Approved meeting request: ${meeting.title}`);
    res.json(updated);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Reject Meeting Request (Admin Only)
app.post('/api/meetings/:id/reject', authenticateToken, authorizeRoles('Super Admin', 'Admin Team'), (req, res) => {
  try {
    const meeting = db.findOne('meetings', m => m.id === req.params.id);
    if (!meeting) return res.status(404).json({ error: 'Meeting not found' });

    const updated = db.update('meetings', meeting.id, { status: 'rejected' });

    const bus = db.findOne('businesses', b => b.id === meeting.business_id);
    if (bus) db.sendNotification(bus.owner_id, 'Meeting Request Rejected', `Your meeting request "${meeting.title}" has been rejected`);

    db.logActivity(req.user.id, 'reject_meeting', `Rejected meeting request: ${meeting.title}`);
    res.json(updated);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Reschedule Meeting Request (Admin Only)
app.post('/api/meetings/:id/reschedule', authenticateToken, authorizeRoles('Super Admin', 'Admin Team'), (req, res) => {
  try {
    const { date_time } = req.body;
    if (!date_time) return res.status(400).json({ error: 'New Date/Time is required' });

    const meeting = db.findOne('meetings', m => m.id === req.params.id);
    if (!meeting) return res.status(404).json({ error: 'Meeting not found' });

    const updated = db.update('meetings', meeting.id, { date_time, status: 'scheduled' });

    const bus = db.findOne('businesses', b => b.id === meeting.business_id);
    if (bus) db.sendNotification(bus.owner_id, 'Meeting Rescheduled', `Your meeting request "${meeting.title}" has been rescheduled for ${date_time}`);

    db.logActivity(req.user.id, 'reschedule_meeting', `Rescheduled meeting "${meeting.title}" to ${date_time}`);
    res.json(updated);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get Scheduled Meetings
app.get('/api/meetings', authenticateToken, (req, res) => {
  try {
    const allMeetings = db.getCollection('meetings');
    if (['Super Admin', 'Admin Team'].includes(req.user.role)) {
      res.json(allMeetings);
    } else if (req.user.role === 'Business Owners') {
      const bus = db.findOne('businesses', b => b.owner_id === req.user.id);
      if (!bus) return res.json([]);
      res.json(allMeetings.filter(m => m.business_id === bus.id));
    } else {
      // General users / Editors / SMMs / Mentees should only see meetings if specifically assigned or scheduled for them
      res.json(allMeetings.filter(m => m.user_id === req.user.id || (m.attendance && m.attendance.includes(req.user.id)) || (m.attendance && m.attendance.includes(req.user.email)) || (m.participants && m.participants.includes(req.user.id))));
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});
// --- WEBRTC SIGNALING API ---
let meetingSignals = {}; // meetingId -> { userId -> { offer, answer, candidates: [] } }

app.post('/api/meetings/signal', authenticateToken, (req, res) => {
  const { meetingId, signalData, type } = req.body;
  if (!meetingId || !signalData || !type) {
    return res.status(400).json({ error: 'Missing required parameters for signaling' });
  }

  if (!meetingSignals[meetingId]) {
    meetingSignals[meetingId] = {};
  }

  if (!meetingSignals[meetingId][req.user.id]) {
    meetingSignals[meetingId][req.user.id] = { candidates: [] };
  }

  if (type === 'offer') {
    meetingSignals[meetingId][req.user.id].offer = signalData;
  } else if (type === 'answer') {
    meetingSignals[meetingId][req.user.id].answer = signalData;
  } else if (type === 'candidate') {
    meetingSignals[meetingId][req.user.id].candidates.push(signalData);
  }

  res.json({ success: true });
});

app.get('/api/meetings/signal/:meetingId/:partnerId', authenticateToken, (req, res) => {
  const { meetingId, partnerId } = req.params;
  
  if (!meetingSignals[meetingId] || !meetingSignals[meetingId][partnerId]) {
    return res.json({ signal: null });
  }
  
  res.json({ signal: meetingSignals[meetingId][partnerId] });
});

app.get('/api/meetings/signals/:meetingId', authenticateToken, (req, res) => {
  const { meetingId } = req.params;
  res.json(meetingSignals[meetingId] || {});
});

app.post('/api/meetings/signal/clear', authenticateToken, (req, res) => {
  const { meetingId } = req.body;
  if (meetingId && meetingSignals[meetingId]) {
    delete meetingSignals[meetingId][req.user.id];
  }
  res.json({ success: true });
});

// --- DEVELOPER TASK MANAGEMENT ROUTES ---

// Create Developer Task (Admin / Business Owner)
app.post('/api/developer-tasks', authenticateToken, authorizeRoles('Super Admin', 'Admin Team', 'Business Owners'), (req, res) => {
  try {
    const { title, description, assigned_to, deadline, priority, task_type } = req.body;
    if (!title || !assigned_to) {
      return res.status(400).json({ error: 'Title and assigned developer are required' });
    }

    const assignee = db.findOne('users', u => u.id === assigned_to);
    if (!assignee) return res.status(404).json({ error: 'Assigned user not found' });

    let business_id = null;
    let business_name = 'Platform';
    if (req.user.role === 'Business Owners') {
      const bus = db.findOne('businesses', b => b.owner_id === req.user.id);
      if (bus) { business_id = bus.id; business_name = bus.business_name; }
    }

    const task = db.insert('developer_tasks', {
      title,
      description: description || '',
      assigned_to,
      assigned_to_name: assignee.full_name,
      assigned_by: req.user.id,
      assigned_by_name: req.user.full_name,
      business_id,
      business_name,
      deadline: deadline || '',
      priority: priority || 'medium',
      task_type: task_type || 'general',
      status: 'pending',
      submission_notes: '',
      submission_url: '',
      history: [{ status: 'pending', user: req.user.full_name, timestamp: new Date().toISOString(), notes: `Task created and assigned to ${assignee.full_name}` }]
    });

    db.sendNotification(assigned_to, 'New Development Task', `You have been assigned a new task: ${title}`);
    db.logActivity(req.user.id, 'create_dev_task', `Created task "${title}" for ${assignee.full_name}`);

    res.status(201).json(task);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get Developer Tasks
app.get('/api/developer-tasks', authenticateToken, (req, res) => {
  try {
    const allTasks = db.getCollection('developer_tasks');
    if (['Super Admin', 'Admin Team'].includes(req.user.role)) {
      res.json(allTasks);
    } else if (req.user.role === 'Business Owners') {
      const bus = db.findOne('businesses', b => b.owner_id === req.user.id);
      res.json(allTasks.filter(t => t.business_id === bus?.id));
    } else {
      // Developers see their own assigned tasks
      res.json(allTasks.filter(t => t.assigned_to === req.user.id));
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Update Developer Task Status
app.patch('/api/developer-tasks/:id/status', authenticateToken, (req, res) => {
  try {
    const { status, notes } = req.body;
    const task = db.findOne('developer_tasks', t => t.id === req.params.id);
    if (!task) return res.status(404).json({ error: 'Task not found' });

    const history = [...task.history, { status, user: req.user.full_name, timestamp: new Date().toISOString(), notes: notes || `Status updated to ${status}` }];
    const updated = db.update('developer_tasks', task.id, { status, history });

    if (status === 'completed') {
      db.sendNotification(task.assigned_by, 'Task Completed', `Task "${task.title}" has been completed by ${req.user.full_name}`);
    }

    res.json(updated);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Developer submits work
app.post('/api/developer-tasks/:id/submit', authenticateToken, (req, res) => {
  try {
    const { submission_notes, submission_url } = req.body;
    const task = db.findOne('developer_tasks', t => t.id === req.params.id);
    if (!task) return res.status(404).json({ error: 'Task not found' });

    const history = [...task.history, { status: 'submitted', user: req.user.full_name, timestamp: new Date().toISOString(), notes: submission_notes || 'Work submitted' }];
    const updated = db.update('developer_tasks', task.id, {
      status: 'submitted',
      submission_notes,
      submission_url,
      history
    });

    db.sendNotification(task.assigned_by, 'Task Submission', `${req.user.full_name} submitted work for task "${task.title}"`);
    res.json(updated);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// --- GROUP CHAT ROUTES ---

// Create Group (Admin / Boss / Business Owner only)
app.post('/api/chat/groups/create', authenticateToken, authorizeRoles('Super Admin', 'Admin Team', 'Business Owners'), (req, res) => {
  try {
    const { name, member_ids } = req.body;
    if (!name || !member_ids || member_ids.length < 2) {
      return res.status(400).json({ error: 'Group name and at least 2 other members are required (3 total minimum)' });
    }

    // Ensure creator is included
    const allMembers = [...new Set([req.user.id, ...member_ids])];
    if (allMembers.length < 3) {
      return res.status(400).json({ error: 'Group must have at least 3 members including the creator' });
    }

    const group = db.insert('chat_groups', {
      name,
      creator_id: req.user.id,
      creator_name: req.user.full_name,
      members: allMembers,
      member_names: allMembers.map(id => {
        const u = db.findOne('users', usr => usr.id === id);
        return u ? u.full_name : 'Unknown';
      })
    });

    db.logActivity(req.user.id, 'create_chat_group', `Created group "${name}" with ${allMembers.length} members`);
    res.status(201).json(group);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get User's Groups
app.get('/api/chat/groups', authenticateToken, (req, res) => {
  try {
    const groups = db.find('chat_groups', g => g.members.includes(req.user.id));
    res.json(groups);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Send Group Message
app.post('/api/chat/groups/:id/send', authenticateToken, (req, res) => {
  try {
    const { message } = req.body;
    if (!message) return res.status(400).json({ error: 'Message is required' });

    const group = db.findOne('chat_groups', g => g.id === req.params.id);
    if (!group) return res.status(404).json({ error: 'Group not found' });
    if (!group.members.includes(req.user.id)) {
      return res.status(403).json({ error: 'You are not a member of this group' });
    }

    const newMsg = {
      group_id: req.params.id,
      sender_id: req.user.id,
      sender_name: req.user.full_name,
      message,
      timestamp: new Date().toISOString()
    };

    db.insert('chat_group_messages', newMsg);

    // Send notification to all group members except sender
    group.members.forEach(memberId => {
      if (memberId !== req.user.id) {
        db.sendNotification(memberId, `New message in ${group.name}`, `${req.user.full_name}: ${message.substring(0, 100)}`);
      }
    });

    res.json(newMsg);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get Group Chat History
app.get('/api/chat/groups/:id/history', authenticateToken, (req, res) => {
  try {
    const group = db.findOne('chat_groups', g => g.id === req.params.id);
    if (!group) return res.status(404).json({ error: 'Group not found' });
    if (!group.members.includes(req.user.id)) {
      return res.status(403).json({ error: 'You are not a member of this group' });
    }

    const messages = db.find('chat_group_messages', m => m.group_id === req.params.id);
    messages.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
    res.json(messages);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Update Group Members (Admin/Boss only)
app.patch('/api/chat/groups/:id/members', authenticateToken, authorizeRoles('Super Admin', 'Admin Team', 'Business Owners'), (req, res) => {
  try {
    const { member_ids } = req.body;
    const group = db.findOne('chat_groups', g => g.id === req.params.id);
    if (!group) return res.status(404).json({ error: 'Group not found' });

    const updatedMembers = [...new Set([group.creator_id, ...member_ids])];
    if (updatedMembers.length < 3) {
      return res.status(400).json({ error: 'Group must have at least 3 members' });
    }

    const updated = db.update('chat_groups', group.id, {
      members: updatedMembers,
      member_names: updatedMembers.map(id => {
        const u = db.findOne('users', usr => usr.id === id);
        return u ? u.full_name : 'Unknown';
      })
    });

    res.json(updated);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Delete Group
app.delete('/api/chat/groups/:id', authenticateToken, authorizeRoles('Super Admin', 'Admin Team', 'Business Owners'), (req, res) => {
  try {
    const group = db.findOne('chat_groups', g => g.id === req.params.id);
    if (!group) return res.status(404).json({ error: 'Group not found' });

    // Delete group messages
    db.find('chat_group_messages', m => m.group_id === req.params.id).forEach(m => {
      db.delete('chat_group_messages', m.id);
    });
    db.delete('chat_groups', req.params.id);

    res.json({ message: 'Group deleted successfully' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// --- MEETING TASK ROUTES (Business Owner -> Admin approval) ---

// Create Meeting Task (Business Owner)
app.post('/api/meetings/tasks', authenticateToken, authorizeRoles('Business Owners'), (req, res) => {
  try {
    const { title, description, participants } = req.body;
    if (!title) return res.status(400).json({ error: 'Task title is required' });

    const bus = db.findOne('businesses', b => b.owner_id === req.user.id);
    if (!bus) return res.status(404).json({ error: 'Business profile not found' });

    const participantNames = (participants || []).map(id => {
      const u = db.findOne('users', usr => usr.id === id);
      return u ? u.full_name : 'Unknown';
    });

    const task = db.insert('meeting_tasks', {
      title,
      description: description || '',
      business_id: bus.id,
      business_name: bus.business_name,
      created_by: req.user.id,
      created_by_name: req.user.full_name,
      participants: participants || [],
      participant_names: participantNames,
      status: 'pending_admin_review',
      admin_notes: '',
      history: [{ status: 'pending_admin_review', user: req.user.full_name, timestamp: new Date().toISOString(), notes: 'Task submitted for admin review' }]
    });

    // Notify admins
    db.find('users', u => ['Super Admin', 'Admin Team'].includes(u.role)).forEach(admin => {
      db.sendNotification(admin.id, 'Meeting Task Request', `Business partner "${bus.business_name}" submitted a task: ${title}`);
    });

    db.logActivity(req.user.id, 'create_meeting_task', `Created meeting task: ${title}`);
    res.status(201).json(task);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get Meeting Tasks
app.get('/api/meetings/tasks', authenticateToken, (req, res) => {
  try {
    const allTasks = db.getCollection('meeting_tasks');
    if (['Super Admin', 'Admin Team'].includes(req.user.role)) {
      res.json(allTasks);
    } else if (req.user.role === 'Business Owners') {
      res.json(allTasks.filter(t => t.created_by === req.user.id));
    } else {
      // Other roles see tasks where they are participants
      res.json(allTasks.filter(t => t.participants.includes(req.user.id)));
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Approve Meeting Task (Admin)
app.patch('/api/meetings/tasks/:id/approve', authenticateToken, authorizeRoles('Super Admin', 'Admin Team'), (req, res) => {
  try {
    const { date_time, admin_notes } = req.body;
    const task = db.findOne('meeting_tasks', t => t.id === req.params.id);
    if (!task) return res.status(404).json({ error: 'Meeting task not found' });

    // Create the meeting
    const meeting = db.insert('meetings', {
      business_id: task.business_id,
      business_name: task.business_name,
      title: task.title,
      date_time: date_time || new Date().toISOString(),
      status: 'scheduled',
      attendance: task.participants,
      participants: task.participants,
      participant_names: task.participant_names,
      notes: task.description,
      follow_ups: admin_notes || ''
    });

    // Notify all participants
    task.participants.forEach(pid => {
      db.sendNotification(pid, 'Meeting Scheduled', `A meeting "${task.title}" has been scheduled. ${date_time ? 'Date: ' + date_time : ''}`);
    });
    db.sendNotification(task.created_by, 'Task Approved & Meeting Created', `Your task "${task.title}" has been approved and a meeting has been scheduled.`);

    const history = [...task.history, { status: 'approved', user: req.user.full_name, timestamp: new Date().toISOString(), notes: admin_notes || 'Task approved and meeting created' }];
    const updated = db.update('meeting_tasks', task.id, { status: 'approved', admin_notes, history });

    db.logActivity(req.user.id, 'approve_meeting_task', `Approved meeting task: ${task.title}`);
    res.json({ task: updated, meeting });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Reject Meeting Task (Admin)
app.patch('/api/meetings/tasks/:id/reject', authenticateToken, authorizeRoles('Super Admin', 'Admin Team'), (req, res) => {
  try {
    const { admin_notes } = req.body;
    const task = db.findOne('meeting_tasks', t => t.id === req.params.id);
    if (!task) return res.status(404).json({ error: 'Meeting task not found' });

    const history = [...task.history, { status: 'rejected', user: req.user.full_name, timestamp: new Date().toISOString(), notes: admin_notes || 'Task rejected by admin' }];
    const updated = db.update('meeting_tasks', task.id, { status: 'rejected', admin_notes, history });

    db.sendNotification(task.created_by, 'Task Rejected', `Your task "${task.title}" has been rejected. Reason: ${admin_notes || 'No reason provided'}`);

    db.logActivity(req.user.id, 'reject_meeting_task', `Rejected meeting task: ${task.title}`);
    res.json(updated);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// --- ROLE-BASED CHAT API ---
app.get('/api/chat/users', authenticateToken, (req, res) => {
  try {
    const allUsers = db.getCollection('users') || [];

    const filtered = allUsers.filter(u => {
      if (u.id === req.user.id) return false; // Don't list self
      // All approved users can see each other for messaging
      return u.status === 'approved';
    }).map(u => ({
      id: u.id,
      full_name: u.full_name,
      email: u.email,
      role: u.role,
      type: 'user'
    }));

    // Also include groups the user belongs to
    const groups = db.find('chat_groups', g => g.members.includes(req.user.id)).map(g => ({
      id: g.id,
      full_name: g.name,
      role: `${g.members.length} members`,
      type: 'group',
      members: g.members,
      member_names: g.member_names
    }));

    res.json([...groups, ...filtered]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/chat/send', authenticateToken, (req, res) => {
  try {
    const { recipient_id, message } = req.body;
    if (!recipient_id || !message) {
      return res.status(400).json({ error: 'recipient_id and message are required' });
    }
    
    const recipient = db.findOne('users', u => u.id === recipient_id);
    if (!recipient) {
      return res.status(404).json({ error: 'Recipient not found' });
    }

    // All approved users can message each other
    if (recipient.status !== 'approved') {
      return res.status(403).json({ error: 'Cannot message unapproved users' });
    }
    
    const newMsg = {
      id: 'msg_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9),
      sender_id: req.user.id,
      recipient_id: recipient_id,
      message: message,
      timestamp: new Date().toISOString()
    };
    
    db.insert('chat_messages', newMsg);

    // Send notification to recipient
    db.sendNotification(recipient_id, `New message from ${req.user.full_name}`, message.substring(0, 100));

    res.json(newMsg);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/chat/history/:partnerId', authenticateToken, (req, res) => {
  try {
    const partnerId = req.params.partnerId;
    const messages = db.find('chat_messages', m => {
      return (m.sender_id === req.user.id && m.recipient_id === partnerId) ||
             (m.sender_id === partnerId && m.recipient_id === req.user.id);
    }) || [];
    
    messages.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
    res.json(messages);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Update Meeting Notes & Attendance
app.put('/api/meetings/:id', authenticateToken, (req, res) => {
  try {
    const { notes, follow_ups, attendance, status } = req.body;
    const meeting = db.findOne('meetings', m => m.id === req.params.id);
    if (!meeting) return res.status(404).json({ error: 'Meeting not found' });

    const updated = db.update('meetings', meeting.id, {
      notes,
      follow_ups,
      attendance,
      status,
      participants: req.body.participants || meeting.participants,
      participant_names: (req.body.participants || meeting.participants || []).map(id => {
        const u = db.findOne('users', usr => usr.id === id);
        return u ? u.full_name : 'Unknown';
      })
    });

    db.logActivity(req.user.id, 'update_meeting', `Updated meeting details for ${meeting.title}`);
    res.json(updated);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// --- MENTORSHIP MODULE ROUTES ---

// Submit Mentorship Request (Mentorship Members)
app.post('/api/mentorship/request', authenticateToken, authorizeRoles('Mentorship Members'), (req, res) => {
  try {
    const { challenges, topics, requested_date } = req.body;
    if (!challenges || !requested_date) return res.status(400).json({ error: 'Challenges and requested date are required' });

    const request = db.insert('mentorship_requests', {
      member_id: req.user.id,
      member_name: req.user.full_name,
      challenges,
      topics,
      requested_date,
      status: 'pending',
      meeting_date: null,
      notes: '',
      recommendations: '',
      action_plans: [],
      history: [{ status: 'pending', timestamp: new Date().toISOString(), notes: 'Mentorship request submitted' }]
    });

    db.logActivity(req.user.id, 'mentorship_request', `Submitted mentorship session request`);
    res.status(201).json(request);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get Mentorship Requests
app.get('/api/mentorship/requests', authenticateToken, (req, res) => {
  try {
    const requests = db.getCollection('mentorship_requests');
    if (['Super Admin', 'Admin Team'].includes(req.user.role)) {
      res.json(requests);
    } else if (req.user.role === 'Mentorship Members') {
      res.json(requests.filter(r => r.member_id === req.user.id));
    } else {
      res.status(403).json({ error: 'Access denied' });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Approve Mentorship Request & Schedule Session
app.post('/api/mentorship/requests/:id/approve', authenticateToken, authorizeRoles('Super Admin', 'Admin Team'), (req, res) => {
  try {
    const { meeting_date } = req.body;
    if (!meeting_date) return res.status(400).json({ error: 'Meeting date is required' });

    const request = db.findOne('mentorship_requests', r => r.id === req.params.id);
    if (!request) return res.status(404).json({ error: 'Mentorship request not found' });

    const history = [...request.history, { status: 'approved', timestamp: new Date().toISOString(), notes: `Approved and scheduled for ${meeting_date}` }];
    const updated = db.update('mentorship_requests', request.id, {
      status: 'approved',
      meeting_date,
      history
    });

    // Notify user
    db.sendNotification(request.member_id, 'Mentorship Session Approved', `Your mentorship session has been approved and scheduled for ${meeting_date}`);
    db.logActivity(req.user.id, 'approve_mentorship_request', `Approved mentorship request for ${request.member_name}`);

    res.json(updated);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Update Mentorship Session notes, recommendations, action plans
app.put('/api/mentorship/requests/:id/session', authenticateToken, authorizeRoles('Super Admin', 'Admin Team'), (req, res) => {
  try {
    const { notes, recommendations, action_plans } = req.body;
    const request = db.findOne('mentorship_requests', r => r.id === req.params.id);
    if (!request) return res.status(404).json({ error: 'Mentorship request not found' });

    const history = [...request.history, { status: 'documented', timestamp: new Date().toISOString(), notes: 'Mentorship session notes documented' }];
    const updated = db.update('mentorship_requests', request.id, {
      notes,
      recommendations,
      action_plans,
      history
    });

    db.logActivity(req.user.id, 'update_mentorship_session', `Updated session notes for mentorship member ${request.member_name}`);
    res.json(updated);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// --- ADMIN / TEAM MEMBERS VIEW USERS ---
app.get('/api/users', authenticateToken, (req, res) => {
  const users = db.getCollection('users').filter(u => u.status === 'approved').map(u => ({
    id: u.id,
    full_name: u.full_name,
    email: u.email,
    role: u.role,
    status: u.status,
    created_at: u.created_at
  }));
  res.json(users);
});

// --- NOTIFICATIONS & WEB PUSH ---
// Override sendNotification to support real-time Web Push notifications in the background
const originalSendNotification = db.sendNotification;
db.sendNotification = (userId, title, message) => {
  originalSendNotification(userId, title, message);
  
  // Find push subscriptions for this user
  const subscriptions = db.find('push_subscriptions', sub => sub.user_id === userId);
  const payload = JSON.stringify({ title, body: message });
  
  subscriptions.forEach(sub => {
    webpush.sendNotification(sub.subscription, payload)
      .catch(err => {
        console.error('Error sending push notification:', err);
        if (err.statusCode === 410 || err.statusCode === 404) {
          // Remove dead subscription
          db.delete('push_subscriptions', sub.id);
        }
      });
  });
};

app.get('/api/notifications/vapid-public-key', (req, res) => {
  const keys = db.findOne('vapid_keys', () => true);
  if (!keys) return res.status(500).json({ error: 'VAPID keys not configured' });
  res.json({ publicKey: keys.publicKey });
});

app.post('/api/notifications/subscribe', authenticateToken, (req, res) => {
  const { subscription } = req.body;
  if (!subscription) return res.status(400).json({ error: 'Subscription object required' });

  // Avoid duplicate subscriptions for the same endpoint
  const existing = db.findOne('push_subscriptions', sub => sub.subscription.endpoint === subscription.endpoint);
  if (existing) {
    db.update('push_subscriptions', existing.id, { user_id: req.user.id });
    return res.status(200).json({ message: 'Subscription updated' });
  }

  db.insert('push_subscriptions', {
    user_id: req.user.id,
    subscription
  });

  res.status(201).json({ message: 'Subscribed successfully' });
});

app.get('/api/notifications', authenticateToken, (req, res) => {
  const list = db.find('notifications', n => n.user_id === req.user.id);
  res.json(list);
});

app.post('/api/notifications/read-all', authenticateToken, (req, res) => {
  const list = db.find('notifications', n => n.user_id === req.user.id);
  list.forEach(n => db.update('notifications', n.id, { is_read: true }));
  res.json({ message: 'Notifications marked read' });
});

// --- SYSTEM CENTRALIZED DASHBOARD DATA ---
app.get('/api/admin/dashboard', authenticateToken, authorizeRoles('Super Admin', 'Admin Team'), (req, res) => {
  try {
    const businesses = db.getCollection('businesses');
    const users = db.getCollection('users');
    const contents = db.getCollection('content_items');
    const meetings = db.getCollection('meetings');
    const mentorship = db.getCollection('mentorship_requests');
    const invoices = db.getCollection('invoices');
    const logs = db.getCollection('activity_logs').slice(-20).reverse();

    // Calculate quick metrics
    const stats = {
      total_businesses: businesses.length,
      pending_approvals: businesses.filter(b => b.status === 'pending').length,
      total_team_members: users.filter(u => ['Video Editors', 'Social Media Managers', 'Admin Team', 'Full Stack Developers', 'Web Developers'].includes(u.role)).length,
      pending_mentorship: mentorship.filter(m => m.status === 'pending').length,
      workflow_active_tasks: contents.filter(c => c.status !== 'published').length,
      total_billing: invoices.filter(i => i.status === 'paid').reduce((acc, curr) => acc + curr.total, 0),
      total_pending_billing: invoices.filter(i => i.status === 'unpaid').reduce((acc, curr) => acc + curr.total, 0)
    };

    res.json({
      stats,
      businesses,
      team_performance: users.filter(u => ['Video Editors', 'Social Media Managers', 'Full Stack Developers', 'Web Developers'].includes(u.role)).map(u => {
        const tasks = contents.filter(c => c.assigned_editor_id === u.id || c.assigned_sm_manager_id === u.id);
        const devTasks = db.getCollection('developer_tasks').filter(t => t.assigned_to === u.id);
        return {
          id: u.id,
          name: u.full_name,
          role: u.role,
          total_tasks: tasks.length + devTasks.length,
          completed: tasks.filter(t => t.status === 'published').length + devTasks.filter(t => t.status === 'completed').length
        };
      }),
      content_workflows: contents,
      meetings,
      mentorship_requests: mentorship,
      invoices,
      logs
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Unified helper to call LLM (Gemini first, fallback to Groq) using native fetch
async function callLLM(systemInstruction, userContent, jsonMode = false) {
  // --- 1. TRY GEMINI ---
  const geminiApiKey = (process.env.GEMINI_API_KEY || '').trim().replace(/[\r\n\t]/g, '');
  if (geminiApiKey && !geminiApiKey.includes('placeholder')) {
    try {
      console.log('Attempting call with Gemini...');
      const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${geminiApiKey}`;
      const body = {
        contents: [
          {
            role: 'user',
            parts: [{ text: userContent }]
          }
        ],
        systemInstruction: {
          parts: [{ text: systemInstruction }]
        },
        generationConfig: {
          temperature: jsonMode ? 0.2 : 0.7,
          maxOutputTokens: 1000
        }
      };

      if (jsonMode) {
        body.generationConfig.responseMimeType = "application/json";
      }

      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error?.message || 'Gemini API call failed');
      }

      const candidate = data.candidates?.[0];
      const text = candidate?.content?.parts?.[0]?.text;
      if (text) {
        console.log('Gemini query completed successfully.');
        return text.trim();
      }
    } catch (geminiError) {
      console.warn('Gemini API failed, trying Groq fallback:', geminiError.message);
    }
  }

  // --- 2. TRY GROQ ---
  const groqApiKey = (process.env.GROQ_API_KEY || '').trim().replace(/[\r\n\t]/g, '');
  if (groqApiKey && !groqApiKey.includes('placeholder')) {
    try {
      console.log('Attempting call with Groq...');
      const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${groqApiKey}`
        },
        body: JSON.stringify({
          model: 'llama-3.3-70b-versatile',
          response_format: jsonMode ? { type: "json_object" } : undefined,
          messages: [
            { role: 'system', content: systemInstruction },
            { role: 'user', content: userContent }
          ],
          temperature: jsonMode ? 0.2 : 0.7,
          max_tokens: 1000
        })
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error?.message || 'Groq API call failed');
      }

      const text = data.choices?.[0]?.message?.content;
      if (text) {
        console.log('Groq query completed successfully.');
        return text.trim();
      }
    } catch (groqError) {
      console.warn('Groq API failed:', groqError.message);
      throw groqError;
    }
  }

  throw new Error('No valid LLM provider keys available or all providers failed');
}

// --- AI VOICE AGENT ROUTE (Super Admin & Admin Team Only) ---
app.post('/api/admin/voice-agent', authenticateToken, authorizeRoles('Super Admin', 'Admin Team'), async (req, res) => {
  try {
    const businesses = db.getCollection('businesses');
    const users = db.getCollection('users');
    const contents = db.getCollection('content_items');
    const meetings = db.getCollection('meetings');
    const mentorship = db.getCollection('mentorship_requests');
    const dailyReports = db.getCollection('daily_reports');
    const orders = db.getCollection('orders');
    const invoices = db.getCollection('invoices');
    const developerTasks = db.getCollection('developer_tasks');

    // Compile comprehensive system context for the AI
    const systemContext = {
      total_businesses: businesses.length,
      pending_approvals: businesses.filter(b => b.status === 'pending').length,
      users: users.map(u => ({ id: u.id, name: u.full_name, role: u.role, status: u.status })),
      businesses: businesses.map(b => ({
        id: b.id,
        business_name: b.business_name,
        industry: b.industry,
        employee_count: b.employee_count,
        status: b.status,
        employees: b.employees || []
      })),
      content_items: contents.map(c => ({
        id: c.id,
        business_id: c.business_id,
        business_name: c.business_name,
        idea: c.content_idea,
        status: c.status,
        assigned_editor_id: c.assigned_editor_id,
        assigned_sm_manager_id: c.assigned_sm_manager_id,
        deadline: c.deadline,
        editor_name: users.find(u => u.id === c.assigned_editor_id)?.full_name || 'Unassigned',
        smm_name: users.find(u => u.id === c.assigned_sm_manager_id)?.full_name || 'Unassigned'
      })),
      meetings: meetings.map(m => ({
        id: m.id,
        business_id: m.business_id,
        business_name: m.business_name,
        title: m.title,
        date_time: m.date_time,
        status: m.status,
        notes: m.notes,
        follow_ups: m.follow_ups
      })),
      daily_reports: dailyReports.map(r => ({
        id: r.id,
        business_id: r.business_id,
        business_name: r.business_name,
        activities: r.activities,
        active_projects: r.active_projects,
        progress: r.progress,
        challenges: r.challenges,
        goals: r.goals,
        updates: r.updates,
        date: r.date
      })),
      orders: orders.map(o => ({
        id: o.id,
        business_id: o.business_id,
        business_name: o.business_name,
        client_name: o.client_name,
        product_service: o.product_service,
        amount: o.amount,
        status: o.status,
        notes: o.notes,
        date: o.date
      })),
      invoices: invoices.map(i => ({
        id: i.id,
        business_id: i.business_id,
        business_name: i.business_name,
        total: i.total,
        status: i.status,
        due_date: i.due_date
      })),
      developer_tasks: developerTasks.map(t => ({
        id: t.id,
        title: t.title,
        assigned_to_name: t.assigned_to_name,
        status: t.status,
        task_type: t.task_type,
        deadline: t.deadline,
        business_name: t.business_name
      }))
    };

    // Local fallback speech generator in case Gemini key fails or is invalid
    const generateFallbackSpeech = (context, query) => {
      if (query) {
        const q = query.toLowerCase();
        
        // Friendly Greetings
        if (q.startsWith('hello') || q.startsWith('hi') || q.includes('hey there') || q.includes('greetings')) {
          return `Hello there, Boss! I hope you are having a wonderful day. How can I help you manage your business portfolios and tasks today?`;
        }
        if (q.includes('how are you') || q.includes('how\'s it going') || q.includes('how do you do')) {
          return `I am doing fantastic, Boss! Thank you so much for asking. I am fully loaded with our business stats and ready to assist you. What can I check for you?`;
        }
        if (q.includes('who are you') || q.includes('your name') || q.includes('what do you do')) {
          return `I am your friendly Ascentra Voice Assistant! I help you track employee workloads, review daily business reports, manage client orders, and give smart suggestions to optimize operations.`;
        }
        if (q.includes('thank you') || q.includes('thanks')) {
          return `You are very welcome, Boss! It is always a pleasure helping you. Let me know if there's anything else you need.`;
        }
        
        // 1. Workload suggestions / reassignments
        if (q.includes('suggest') || q.includes('free') || q.includes('assign') || q.includes('workload')) {
          const editors = context.users.filter(u => u.role === 'Video Editors' && u.status === 'approved');
          const editorWorkloads = editors.map(e => {
            const active = context.content_items.filter(c => c.assigned_editor_id === e.id && ['assigned_editor', 'editor_submitted'].includes(c.status));
            return { user: e, count: active.length, tasks: active };
          });
          
          const overloaded = editorWorkloads.find(w => w.count >= 2);
          const freeEditor = editorWorkloads.find(w => w.count === 0);
          
          if (overloaded && freeEditor) {
            const taskToMove = overloaded.tasks[0];
            return `I noticed a small workload mismatch. Our editor ${overloaded.user.name} is handling ${overloaded.count} active tasks, while ${freeEditor.user.name} is completely free right now. I highly suggest reassigning the task "${taskToMove.idea}" for ${taskToMove.business_name} to ${freeEditor.user.name} to balance the load and speed up production!`;
          }
          
          const smms = context.users.filter(u => u.role === 'Social Media Managers' && u.status === 'approved');
          const smmWorkloads = smms.map(s => {
            const active = context.content_items.filter(c => c.assigned_sm_manager_id === s.id && c.status === 'assigned_sm_manager');
            return { user: s, count: active.length, tasks: active };
          });
          
          const overloadedSmm = smmWorkloads.find(w => w.count >= 2);
          const freeSmm = smmWorkloads.find(w => w.count === 0);
          
          if (overloadedSmm && freeSmm) {
            const taskToMove = overloadedSmm.tasks[0];
            return `I suggest shifting the social publishing task "${taskToMove.idea}" for ${taskToMove.business_name} from ${overloadedSmm.user.name} to ${freeSmm.user.name}. ${overloadedSmm.user.name} has ${overloadedSmm.count} tasks, while ${freeSmm.user.name} is currently free.`;
          }
          
          return `Everything looks great and balanced right now, Boss! All approved video editors and social managers are carrying reasonable workloads.`;
        }

        // 2. Specific person lookup (e.g. David, Sarah, Taha)
        for (const user of context.users) {
          const names = user.name.toLowerCase().split(' ');
          const matches = names.some(n => q.includes(n) && n.length > 2);
          if (matches) {
            const editorTasks = context.content_items.filter(c => c.assigned_editor_id === user.id && ['assigned_editor', 'editor_submitted'].includes(c.status));
            const smmTasks = context.content_items.filter(c => c.assigned_sm_manager_id === user.id && c.status === 'assigned_sm_manager');
            const totalActive = editorTasks.length + smmTasks.length;
            
            if (totalActive === 0) {
              return `Ah, ${user.name} is currently free with no active content tasks assigned. They are ready for any new work you have!`;
            }
            
            let details = `Well, ${user.name} is currently working on ${totalActive} active task(s). `;
            if (editorTasks.length > 0) {
              details += `For editing: they are working on ${editorTasks.map(t => `"${t.idea}" for ${t.business_name} (status: ${t.status}, deadline: ${t.deadline || 'none'})`).join(', ')}. `;
            }
            if (smmTasks.length > 0) {
              details += `For social publishing: they are working on ${smmTasks.map(t => `"${t.idea}" for ${t.business_name}`).join(', ')}. `;
            }
            return details;
          }
        }

        // 3. Specific business report lookup
        for (const biz of context.businesses) {
          if (q.includes(biz.business_name.toLowerCase()) || q.includes(biz.business_name.split(' ')[0].toLowerCase())) {
            const bizId = biz.id;
            const bizOrders = context.orders.filter(o => o.business_id === bizId);
            const pendingOrders = bizOrders.filter(o => o.status === 'pending' || o.status === 'in_progress');
            const completedOrders = bizOrders.filter(o => o.status === 'completed');
            
            const bizReports = context.daily_reports.filter(r => r.business_id === bizId);
            const latestReport = bizReports.length > 0 ? bizReports[bizReports.length - 1] : null;
            
            const bizContents = context.content_items.filter(c => c.business_id === bizId);
            const activeContents = bizContents.filter(c => c.status !== 'published');
            
            let report = `Here is the friendly business report for ${biz.business_name} (${biz.industry})! `;
            report += `They have a team of ${biz.employee_count || 0} employees. `;
            
            if (latestReport) {
              report += `According to their latest daily update, the activities were: "${latestReport.activities}". `;
              if (latestReport.challenges && latestReport.challenges.toLowerCase() !== 'none') {
                report += `They ran into a challenge: "${latestReport.challenges}". `;
              }
              if (latestReport.goals) {
                report += `Their main goals right now are: "${latestReport.goals}". `;
              }
            } else {
              report += `No daily reports have been filed recently. `;
            }
            
            if (bizOrders.length > 0) {
              report += `On the order board, they have ${completedOrders.length} completed orders and ${pendingOrders.length} active orders. `;
              if (pendingOrders.length > 0) {
                report += `Currently processing: ${pendingOrders.map(o => `${o.product_service} for ${o.client_name} (status: ${o.status})`).join(', ')}. `;
              }
            } else {
              report += `They don't have any active orders right now. `;
            }
            
            if (activeContents.length > 0) {
              report += `Also, there are ${activeContents.length} items moving through the content creation pipeline. `;
            }
            return report;
          }
        }

        // 4. Default query fallback search reply
        return `Hello Boss! I would love to answer that for you. Currently, my connection to the Gemini cloud brain is offline (please check if your API key is configured correctly), but I am right here and ready to help you with any platform operations! You can ask me what David or other team members are doing, ask for task assignment suggestions, or request a detailed business report for portfolios like Apex Solutions. What would you like to check?`;
      }

      // Default operations briefing (if query is empty)
      const pendingBiz = context.pending_approvals;
      const activeEdits = context.content_items.filter(c => c.status === 'assigned_editor');
      const activePublishes = context.content_items.filter(c => c.status === 'assigned_sm_manager');
      const briefings = context.meetings.filter(m => m.status === 'scheduled');

      let speech = `Hello Boss! Welcome back. Here is your friendly operations briefing. We currently have ${context.total_businesses} partner portfolios registered on Ascentra, with ${pendingBiz} awaiting your review. `;
      if (activeEdits.length > 0) {
        speech += `Right now, ${activeEdits.length} video projects are actively being edited. `;
      } else {
        speech += `There are no video editing tasks in progress at the moment. `;
      }
      if (activePublishes.length > 0) {
        speech += `${activePublishes.length} approved videos are in queue for social media posting. `;
      }
      if (briefings.length > 0) {
        speech += `We also have ${briefings.length} upcoming meetings scheduled. Let me know if you'd like me to look into any specific details!`;
      }
      return speech;
    };

    // Make request using callLLM helper
    const geminiApiKey = (process.env.GEMINI_API_KEY || '').trim().replace(/[\r\n\t]/g, '');
    const groqApiKey = (process.env.GROQ_API_KEY || '').trim().replace(/[\r\n\t]/g, '');
    const hasGemini = geminiApiKey && !geminiApiKey.includes('placeholder');
    const hasGroq = groqApiKey && !groqApiKey.includes('placeholder');

    if (!hasGemini && !hasGroq) {
      const fallbackText = generateFallbackSpeech(systemContext, req.body.query);
      return res.json({ speechText: fallbackText });
    }

    try {
      const systemInstruction = `You are the Ascentra Command Business Intelligence Voice Assistant. You are a friendly, conversational, and highly helpful AI companion briefing the Owner (Boss) or Super Admin.
You have access to the complete database of businesses, users, content tasks, daily reports, orders, meetings, invoices, and mentorship requests.

Instructions:
1. TONALITY: Speak in a warm, friendly, conversational, and highly helpful manner. Address the user respectfully (e.g. as Boss, Owner, or Sir). Use positive and encouraging words.
2. ANSWER ANY QUESTION: Answer ANY question the user asks. If the user greets you or asks general chit-chat questions (e.g. "how is the weather?", "tell me a joke", or general knowledge), answer them in a warm, friendly way. Never refuse to answer or say you are limited.
3. WHO IS DOING WHAT:
   - If the user asks about a specific person (e.g. "what is David doing?"), check if they have active assignments in the content_items pipeline. Identify if they are free or overloaded, and report their active tasks, status, and deadlines in a friendly tone.
4. WORKLOAD SUGGESTIONS & ASSIGNMENTS:
   - Check if any approved team member (e.g., Video Editors, Social Media Managers) is "free" (has 0 active tasks) while another person is overloaded (has 2 or more active tasks).
   - If so, suggest that the Boss reassign specific tasks from the overloaded person to the free person to balance the load. Clearly name the tasks, the overloaded person, and the free person.
5. BUSINESS REPORTS:
   - If the user asks for a report on a specific business (e.g., "what is the report of Apex Solutions?"), retrieve all details for that business:
     * Business Details: Industry, employee count, status.
     * Orders Processing: List all orders for the business, detailing their status ('pending', 'in_progress', 'completed') and notes.
     * Daily Reports: Read the latest daily report's activities, active projects, progress, challenges, and goals.
     * Content items and Financials (invoices).
     * Summarize these clearly to explain what they are currently doing, their progress, and any challenges/blockers they face.

Format the response to be clean, readable, and well-suited to be read aloud by a Text-to-Speech engine. Keep it direct and professional but friendly and warm.`;

      const userContent = req.body.query 
        ? `Based on this platform data:\n${JSON.stringify(systemContext, null, 2)}\n\nAnswer the user's voice command/question: "${req.body.query}".`
        : `Here is the current platform data to analyze:\n${JSON.stringify(systemContext, null, 2)}`;

      const speechText = await callLLM(systemInstruction, userContent, false);
      res.json({ speechText });
    } catch (apiError) {
      console.warn('All LLM providers failed, using local fallback agent:', apiError.message);
      const fallbackText = generateFallbackSpeech(systemContext, req.body.query);
      res.json({ speechText: fallbackText });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Approve or Update User Status (Admin Only)
app.patch('/api/users/:id/status', authenticateToken, authorizeRoles('Super Admin', 'Admin Team'), (req, res) => {
  try {
    const { status } = req.body;
    const targetUser = db.findOne('users', u => u.id === req.params.id);
    if (!targetUser) return res.status(404).json({ error: 'User not found' });

    const updated = db.update('users', targetUser.id, { status });

    db.sendNotification(targetUser.id, 'Account Status Updated', `Your account status has been set to: ${status}`);
    db.logActivity(req.user.id, 'update_user_status', `Updated status of user ${targetUser.full_name} to ${status}`);

    res.json(updated);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// --- EMPLOYEE MANAGEMENT ROUTES ---

// Get Employees of My Business
app.get('/api/businesses/my/employees', authenticateToken, authorizeRoles('Business Owners'), (req, res) => {
  try {
    const bus = db.findOne('businesses', b => b.owner_id === req.user.id);
    if (!bus) return res.status(404).json({ error: 'Business profile not found' });
    res.json(bus.employees || []);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Add Employee to My Business
app.post('/api/businesses/my/employees', authenticateToken, authorizeRoles('Business Owners'), (req, res) => {
  try {
    const { name, role, email, status } = req.body;
    if (!name || !role) return res.status(400).json({ error: 'Name and Role are required' });

    const bus = db.findOne('businesses', b => b.owner_id === req.user.id);
    if (!bus) return res.status(404).json({ error: 'Business profile not found' });

    const employees = bus.employees || [];
    const newEmp = {
      id: `emp-${Date.now()}`,
      name,
      role,
      email: email || '',
      status: status || 'Active',
      joined_date: new Date().toISOString().split('T')[0]
    };
    employees.push(newEmp);
    db.update('businesses', bus.id, { employees });
    
    db.logActivity(req.user.id, 'add_employee', `Added employee ${name} as ${role}`);
    res.status(201).json(newEmp);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Delete/Remove Employee from My Business
app.delete('/api/businesses/my/employees/:empId', authenticateToken, authorizeRoles('Business Owners'), (req, res) => {
  try {
    const bus = db.findOne('businesses', b => b.owner_id === req.user.id);
    if (!bus) return res.status(404).json({ error: 'Business profile not found' });

    const employees = bus.employees || [];
    const filtered = employees.filter(e => e.id !== req.params.empId);
    db.update('businesses', bus.id, { employees: filtered });

    db.logActivity(req.user.id, 'remove_employee', `Removed employee from portfolio`);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// --- ORDER MANAGEMENT ROUTES ---

// Create Order (Business Owner Only)
app.post('/api/orders', authenticateToken, authorizeRoles('Business Owners'), (req, res) => {
  try {
    const { client_name, product_service, amount, status, notes } = req.body;
    if (!client_name || !product_service || !amount) {
      return res.status(400).json({ error: 'Client name, product/service, and amount are required' });
    }

    const bus = db.findOne('businesses', b => b.owner_id === req.user.id);
    if (!bus) return res.status(404).json({ error: 'Business profile not found' });

    const newOrder = db.insert('orders', {
      business_id: bus.id,
      business_name: bus.business_name,
      client_name,
      product_service,
      amount: parseFloat(amount),
      status: status || 'pending',
      notes: notes || '',
      date: new Date().toISOString().split('T')[0]
    });

    db.logActivity(req.user.id, 'create_order', `Created client order for ${client_name} - ${product_service}`);
    res.status(201).json(newOrder);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get Orders (Admins & Owners)
app.get('/api/orders', authenticateToken, (req, res) => {
  try {
    const allOrders = db.getCollection('orders');
    if (['Super Admin', 'Admin Team'].includes(req.user.role)) {
      res.json(allOrders);
    } else if (req.user.role === 'Business Owners') {
      const bus = db.findOne('businesses', b => b.owner_id === req.user.id);
      if (!bus) return res.status(404).json({ error: 'Business profile not found' });
      res.json(allOrders.filter(o => o.business_id === bus.id));
    } else {
      res.status(403).json({ error: 'Access denied' });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Update Order Status
app.patch('/api/orders/:id/status', authenticateToken, (req, res) => {
  try {
    const { status, notes } = req.body;
    const order = db.findOne('orders', o => o.id === req.params.id);
    if (!order) return res.status(404).json({ error: 'Order not found' });

    if (req.user.role === 'Business Owners') {
      const bus = db.findOne('businesses', b => b.owner_id === req.user.id);
      if (order.business_id !== bus.id) return res.status(403).json({ error: 'Unauthorized to edit this order' });
    }

    const updates = { status };
    if (notes !== undefined) updates.notes = notes;

    const updated = db.update('orders', order.id, updates);
    db.logActivity(req.user.id, 'update_order', `Updated order ${order.id} status to ${status}`);
    res.json(updated);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Helper for generating fallback meeting summary
function generateFallbackSummary(transcript) {
  const lines = transcript.split(/[.!?\n]/).map(s => s.trim()).filter(Boolean);
  const notesList = [];
  const followUpsList = [];

  const actionKeywords = ['todo', 'action', 'will', 'need to', 'must', 'should', 'assign', 'task', 'follow up', 'responsible'];
  const discussionKeywords = ['agree', 'decide', 'think', 'suggest', 'opinion', 'discuss', 'talk', 'conclude', 'proposal', 'idea'];

  for (const line of lines) {
    const lower = line.toLowerCase();
    let classified = false;

    // Check action item keywords
    if (actionKeywords.some(keyword => lower.includes(keyword))) {
      followUpsList.push(`- ${line}`);
      classified = true;
    }
    // Check discussion/decision keywords
    if (discussionKeywords.some(keyword => lower.includes(keyword))) {
      notesList.push(line);
      classified = true;
    }

    // If not classified, add to notes if it seems informative
    if (!classified && line.split(' ').length > 4) {
      notesList.push(line);
    }
  }

  // Formatting notes
  const notesText = notesList.length > 0 
    ? notesList.join('. ') + '.' 
    : "The meeting participants discussed project status, key milestones, and ongoing business operations.";

  // Formatting follow-ups
  const followUpsText = followUpsList.length > 0 
    ? followUpsList.join('\n') 
    : "- Review active campaign metrics and verify progress.\n- Follow up on pending items as discussed.";

  return {
    notes: notesText,
    follow_ups: followUpsText
  };
}

// POST /api/meetings/summarize-transcript
app.post('/api/meetings/summarize-transcript', authenticateToken, async (req, res) => {
  try {
    const { transcript } = req.body;
    if (!transcript || !transcript.trim()) {
      return res.json({
        notes: "No transcript recorded for this meeting.",
        follow_ups: "No follow-up action items identified."
      });
    }

    const geminiApiKey = (process.env.GEMINI_API_KEY || '').trim().replace(/[\r\n\t]/g, '');
    const groqApiKey = (process.env.GROQ_API_KEY || '').trim().replace(/[\r\n\t]/g, '');
    const hasGemini = geminiApiKey && !geminiApiKey.includes('placeholder');
    const hasGroq = groqApiKey && !groqApiKey.includes('placeholder');

    if (!hasGemini && !hasGroq) {
      const fallback = generateFallbackSummary(transcript);
      return res.json(fallback);
    }

    try {
      const systemInstruction = `You are an AI meeting transcription assistant. Analyze the provided meeting transcript and generate structured meeting minutes. 
You must respond with a JSON object containing two keys: "notes" and "follow_ups".
- "notes": a paragraph summarizing the main discussion points, key decisions made, and overall meeting agenda.
- "follow_ups": a list of specific action items, tasks, and follow-ups with owners if mentioned (formatted as bullet points).`;

      const userContent = `Here is the meeting transcript:\n\n${transcript}`;

      const responseText = await callLLM(systemInstruction, userContent, true);
      const result = JSON.parse(responseText);
      res.json({
        notes: result.notes || "No discussion points summarized.",
        follow_ups: result.follow_ups || "No follow-up action items identified."
      });
    } catch (apiError) {
      console.warn('All LLM providers failed or timed out, using local fallback summary:', apiError.message);
      const fallback = generateFallbackSummary(transcript);
      res.json(fallback);
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/voice-agent/transcribe
// Transcribes uploaded voice agent audio chunk using Groq Whisper API
app.post('/api/voice-agent/transcribe', authenticateToken, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No audio file uploaded' });
    }

    const groqApiKey = (process.env.GROQ_API_KEY || '').trim().replace(/[\r\n\t]/g, '');
    if (!groqApiKey || groqApiKey.includes('placeholder')) {
      return res.status(500).json({ error: 'Groq API Key is not configured on the server' });
    }

    // Read the uploaded file
    const fileBuffer = fs.readFileSync(req.file.path);
    
    // Create FormData for Groq
    const formData = new FormData();
    const fileBlob = new Blob([fileBuffer], { type: req.file.mimetype });
    formData.append('file', fileBlob, req.file.originalname);
    formData.append('model', 'whisper-large-v3');

    // Send to Groq Whisper API
    const response = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${groqApiKey}`
      },
      body: formData
    });

    // Cleanup local temp file asynchronously
    fs.unlink(req.file.path, () => {});

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Groq transcription API failed:', errorText);
      return res.status(response.status).json({ error: 'Groq transcription failed: ' + errorText });
    }

    const data = await response.json();
    res.json({ text: data.text });
  } catch (error) {
    console.error('Error in transcribe endpoint:', error);
    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    res.status(500).json({ error: 'Internal server error: ' + error.message });
  }
});

// Serve frontend SPA index file
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Ascentra Unified Platform running on port ${PORT}`);
});
