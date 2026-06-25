require('dotenv').config();
const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const db = require('./database');

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
    const { full_name, email, password, role } = req.body;
    if (!full_name || !email || !password || !role) {
      return res.status(400).json({ error: 'All fields are required' });
    }

    const existingUser = db.findOne('users', u => u.email === email);
    if (existingUser) return res.status(400).json({ error: 'Email already registered' });

    // Hash password
    const password_hash = bcrypt.hashSync(password, 10);

    const newUser = db.insert('users', {
      full_name,
      email,
      password_hash,
      role,
      status: role === 'Mentorship Members' ? 'pending' : 'approved' // Mentorship needs approval, editors/sm approved by default
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

// Create Invitation (Admin Only)
app.post('/api/invitations/create', authenticateToken, authorizeRoles('Super Admin', 'Admin Team'), (req, res) => {
  try {
    const { business_name } = req.body;
    if (!business_name) return res.status(400).json({ error: 'Business name is required' });

    const code = `INV-${business_name.replace(/\s+/g, '-').toUpperCase()}-${Math.floor(1000 + Math.random() * 9000)}`;
    const invite = db.insert('invitations', {
      code,
      business_name,
      is_used: false
    });

    db.logActivity(req.user.id, 'create_invitation', `Generated invitation ${code} for ${business_name}`);
    res.status(201).json(invite);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

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
      if (!bus) return res.status(404).json({ error: 'Business profile not found' });
      res.json(allMeetings.filter(m => m.business_id === bus.id || !m.business_id));
    } else {
      res.json(allMeetings);
    }
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
      status
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
app.get('/api/users', authenticateToken, authorizeRoles('Super Admin', 'Admin Team'), (req, res) => {
  const users = db.getCollection('users').map(u => ({
    id: u.id,
    full_name: u.full_name,
    email: u.email,
    role: u.role,
    status: u.status,
    created_at: u.created_at
  }));
  res.json(users);
});

// --- NOTIFICATIONS ---
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
      total_team_members: users.filter(u => ['Video Editors', 'Social Media Managers', 'Admin Team'].includes(u.role)).length,
      pending_mentorship: mentorship.filter(m => m.status === 'pending').length,
      workflow_active_tasks: contents.filter(c => c.status !== 'published').length,
      total_billing: invoices.filter(i => i.status === 'paid').reduce((acc, curr) => acc + curr.total, 0),
      total_pending_billing: invoices.filter(i => i.status === 'unpaid').reduce((acc, curr) => acc + curr.total, 0)
    };

    res.json({
      stats,
      businesses,
      team_performance: users.filter(u => ['Video Editors', 'Social Media Managers'].includes(u.role)).map(u => {
        const tasks = contents.filter(c => c.assigned_editor_id === u.id || c.assigned_sm_manager_id === u.id);
        return {
          id: u.id,
          name: u.full_name,
          role: u.role,
          total_tasks: tasks.length,
          completed: tasks.filter(t => t.status === 'published').length
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

// --- AI VOICE AGENT ROUTE (Super Admin & Admin Team Only) ---
app.post('/api/admin/voice-agent', authenticateToken, authorizeRoles('Super Admin', 'Admin Team'), async (req, res) => {
  try {
    const businesses = db.getCollection('businesses');
    const users = db.getCollection('users');
    const contents = db.getCollection('content_items');
    const meetings = db.getCollection('meetings');
    const mentorship = db.getCollection('mentorship_requests');
    const dailyReports = db.getCollection('daily_reports');

    // Compile active status of users and activities
    const systemContext = {
      total_businesses: businesses.length,
      pending_approvals: businesses.filter(b => b.status === 'pending').length,
      video_editors: users.filter(u => u.role === 'Video Editors').map(u => ({ id: u.id, name: u.full_name })),
      smm_managers: users.filter(u => u.role === 'Social Media Managers').map(u => ({ id: u.id, name: u.full_name })),
      content_status: contents.map(c => ({
        business_name: c.business_name,
        idea: c.content_idea,
        status: c.status,
        editor: users.find(u => u.id === c.assigned_editor_id)?.full_name || 'Unassigned',
        smm: users.find(u => u.id === c.assigned_sm_manager_id)?.full_name || 'Unassigned'
      })),
      scheduled_briefings: meetings.filter(m => m.status === 'scheduled').map(m => ({ title: m.title, time: m.date_time, biz: m.business_name })),
      mentorship_track: mentorship.map(m => ({ member: m.member_name, challenge: m.challenges, status: m.status, date: m.meeting_date })),
      daily_reports_today: dailyReports.slice(-5).map(r => ({ biz: r.business_name, activities: r.activities }))
    };

    // Local fallback speech generator in case OpenAI key fails or is invalid
    const generateFallbackSpeech = (context, query) => {
      if (query) {
        const q = query.toLowerCase();
        // Check if query is about video editors
        if (q.includes('editor') || q.includes('edit') || q.includes('video')) {
          const activeEdits = context.content_status.filter(c => c.status === 'assigned_editor');
          if (activeEdits.length === 0) {
            return `No video editors are currently editing content. All tasks are completed or pending assignment.`;
          }
          const details = activeEdits.map(c => `${c.editor} is editing content for ${c.business_name}`).join(', ');
          return `Currently, the active video editors are doing the following: ${details}.`;
        }
        // Check if query is about social media or publishing
        if (q.includes('social') || q.includes('publish') || q.includes('smm') || q.includes('post')) {
          const pendingPublish = context.content_status.filter(c => c.status === 'assigned_sm_manager');
          if (pendingPublish.length === 0) {
            return `No active publishing tasks are currently assigned to social media managers.`;
          }
          const details = pendingPublish.map(c => `${c.smm} is dispatching content for ${c.business_name}`).join(', ');
          return `Regarding social publishing: ${details}.`;
        }
        // Check if query is about meetings
        if (q.includes('meeting') || q.includes('brief') || q.includes('schedule')) {
          if (context.scheduled_briefings.length === 0) {
            return `There are no scheduled weekly meetings on the tracker at this moment.`;
          }
          const details = context.scheduled_briefings.map(m => `${m.title} for ${m.biz}`).join(', ');
          return `We have the following meetings scheduled: ${details}.`;
        }
        // General search for names or businesses in database
        for (const user of users) {
          if (q.includes(user.full_name.toLowerCase())) {
            const tasks = context.content_status.filter(c => c.editor === user.full_name || c.smm === user.full_name);
            if (tasks.length === 0) return `${user.full_name} is currently idle with no active content tasks assigned.`;
            return `${user.full_name} is working on tasks: ${tasks.map(t => `${t.status} for ${t.business_name}`).join(', ')}.`;
          }
        }
        for (const biz of businesses) {
          if (q.includes(biz.business_name.toLowerCase())) {
            const tasks = context.content_status.filter(c => c.business_name === biz.business_name);
            if (tasks.length === 0) return `${biz.business_name} has no active content items in the pipeline.`;
            return `${biz.business_name} has content status: ${tasks.map(t => `${t.status} (Editor: ${t.editor})`).join(', ')}.`;
          }
        }
        // Fallback search reply
        return `I parsed the platform logs. We have ${context.total_businesses} partner businesses, ${context.video_editors.length} video editors, and ${context.smm_managers.length} social managers. Ask me specifically about task assignments or scheduled meetings.`;
      }

      // Default operations briefing
      const pendingBiz = context.pending_approvals;
      const activeEdits = context.content_status.filter(c => c.status === 'assigned_editor');
      const activePublishes = context.content_status.filter(c => c.status === 'assigned_sm_manager');
      const briefings = context.scheduled_briefings;

      let speech = `Hello. Here is your operational briefing. We have ${context.total_businesses} partner portfolios registered, with ${pendingBiz} awaiting approval. `;
      if (activeEdits.length > 0) {
        speech += `${activeEdits.length} videos are currently in production with editors. `;
      } else {
        speech += `No editing tasks are currently in progress. `;
      }
      if (activePublishes.length > 0) {
        speech += `${activePublishes.length} approved assets are queued for social media dispatching. `;
      }
      if (briefings.length > 0) {
        speech += `There are ${briefings.length} scheduled briefings upcoming. `;
      }
      return speech;
    };

    // Make request to OpenAI Chat Completions API using global fetch
    const openaiApiKey = process.env.OPENAI_API_KEY;
    if (!openaiApiKey || openaiApiKey.startsWith('sk-proj-**') || openaiApiKey.includes('placeholder')) {
      // Local fallback if key is not configured or is a placeholder
      const fallbackText = generateFallbackSpeech(systemContext, req.body.query);
      return res.json({ speechText: fallbackText });
    }

    try {
      const openaiResponse = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${openaiApiKey}`
        },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          messages: [
            {
              role: 'system',
              content: `You are the Ascentra Command Voice Assistant. You are briefing the Owner (Boss) or Admin Team. Based on the system data, analyze all workflows and report who is doing what (e.g. which video editors are active, what social media managers have published, who has submitted daily reports, and what meetings are scheduled). Speak directly, briefly, and professionally in 3-4 sentences. Format it to be read aloud by a Text-to-Speech engine.`
            },
            {
              role: 'user',
              content: req.body.query 
                ? `Based on this platform data:\n${JSON.stringify(systemContext, null, 2)}\n\nAnswer the user's voice command/question: "${req.body.query}". Speak directly, briefly, and professionally in 3-4 sentences. Format for text-to-speech output.`
                : `Here is the current platform data to analyze:\n${JSON.stringify(systemContext, null, 2)}`
            }
          ],
          temperature: 0.7,
          max_tokens: 250
        })
      });

      const openaiData = await openaiResponse.json();
      if (!openaiResponse.ok) {
        throw new Error(openaiData.error?.message || 'OpenAI API call failed');
      }

      const speechText = openaiData.choices[0].message.content.trim();
      res.json({ speechText });
    } catch (apiError) {
      console.warn('OpenAI API authentication failed, using local fallback agent:', apiError.message);
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

    const openaiApiKey = process.env.OPENAI_API_KEY;
    if (!openaiApiKey || openaiApiKey.startsWith('sk-proj-**') || openaiApiKey.includes('placeholder')) {
      const fallback = generateFallbackSummary(transcript);
      return res.json(fallback);
    }

    try {
      const openaiResponse = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${openaiApiKey}`
        },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          response_format: { type: "json_object" },
          messages: [
            {
              role: 'system',
              content: `You are an AI meeting transcription assistant. Analyze the provided meeting transcript and generate structured meeting minutes. 
You must respond with a JSON object containing two keys: "notes" and "follow_ups".
- "notes": a paragraph summarizing the main discussion points, key decisions made, and overall meeting agenda.
- "follow_ups": a list of specific action items, tasks, and follow-ups with owners if mentioned (formatted as bullet points).`
            },
            {
              role: 'user',
              content: `Here is the meeting transcript:\n\n${transcript}`
            }
          ],
          temperature: 0.5,
          max_tokens: 600
        })
      });

      const openaiData = await openaiResponse.json();
      if (!openaiResponse.ok) {
        throw new Error(openaiData.error?.message || 'OpenAI API call failed');
      }

      const result = JSON.parse(openaiData.choices[0].message.content.trim());
      res.json({
        notes: result.notes || "No discussion points summarized.",
        follow_ups: result.follow_ups || "No follow-up action items identified."
      });
    } catch (apiError) {
      console.warn('OpenAI API call failed or timed out, using local fallback summary:', apiError.message);
      const fallback = generateFallbackSummary(transcript);
      res.json(fallback);
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
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
