const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, 'db.json');

// Initialize database with default seed data
const defaultDB = {
  users: [
    {
      id: 'admin-1',
      full_name: 'Owner Boss',
      email: 'boss@ascentra.com',
      password_hash: '$2a$10$EA/Hr5Pz21o2/xoAIQP8dus8xPGmjLJ1I5whiA.YzZc6frjh2F0Qu', // Password123!
      role: 'Super Admin',
      status: 'approved',
      created_at: new Date().toISOString()
    },
    {
      id: 'admin-2',
      full_name: 'Admin Assistant',
      email: 'admin@ascentra.com',
      password_hash: '$2a$10$EA/Hr5Pz21o2/xoAIQP8dus8xPGmjLJ1I5whiA.YzZc6frjh2F0Qu', // Password123!
      role: 'Admin Team',
      status: 'approved',
      created_at: new Date().toISOString()
    },
    {
      id: 'editor-1',
      full_name: 'David Editor',
      email: 'editor@ascentra.com',
      password_hash: '$2a$10$EA/Hr5Pz21o2/xoAIQP8dus8xPGmjLJ1I5whiA.YzZc6frjh2F0Qu', // Password123!
      role: 'Video Editors',
      status: 'approved',
      created_at: new Date().toISOString()
    },
    {
      id: 'sm-1',
      full_name: 'Sarah Manager',
      email: 'sm@ascentra.com',
      password_hash: '$2a$10$EA/Hr5Pz21o2/xoAIQP8dus8xPGmjLJ1I5whiA.YzZc6frjh2F0Qu', // Password123!
      role: 'Social Media Managers',
      status: 'approved',
      created_at: new Date().toISOString()
    }
  ],
  invitations: [
    { id: 'inv-1', code: 'INV-APEX-2026', business_name: 'Apex Solutions', is_used: false, created_at: new Date().toISOString() },
    { id: 'inv-2', code: 'INV-GREEN-2026', business_name: 'GreenPulse Co', is_used: false, created_at: new Date().toISOString() }
  ],
  businesses: [],
  daily_reports: [],
  content_items: [],
  invoices: [],
  meetings: [],
  mentorship_requests: [],
  notifications: [],
  activity_logs: [],
  orders: [],
  developer_tasks: [],
  chat_groups: [],
  chat_group_messages: [],
  meeting_tasks: []
};

function readDB() {
  if (!fs.existsSync(DB_PATH)) {
    fs.writeFileSync(DB_PATH, JSON.stringify(defaultDB, null, 2), 'utf-8');
    return defaultDB;
  }
  try {
    const data = fs.readFileSync(DB_PATH, 'utf-8');
    return JSON.parse(data);
  } catch (e) {
    console.error('Error reading DB, resetting to default', e);
    return defaultDB;
  }
}

function writeDB(data) {
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2), 'utf-8');
}

const db = {
  getCollection: (name) => {
    const store = readDB();
    return store[name] || [];
  },

  saveCollection: (name, items) => {
    const store = readDB();
    store[name] = items;
    writeDB(store);
  },

  find: (collection, queryFn) => {
    const items = db.getCollection(collection);
    return items.filter(queryFn);
  },

  findOne: (collection, queryFn) => {
    const items = db.getCollection(collection);
    return items.find(queryFn);
  },

  insert: (collection, item) => {
    const items = db.getCollection(collection);
    const newItem = {
      id: `${collection.slice(0, 3)}-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`,
      created_at: new Date().toISOString(),
      ...item
    };
    items.push(newItem);
    db.saveCollection(collection, items);
    return newItem;
  },

  update: (collection, id, updates) => {
    const items = db.getCollection(collection);
    const idx = items.findIndex(x => x.id === id);
    if (idx === -1) return null;
    items[idx] = { ...items[idx], ...updates, updated_at: new Date().toISOString() };
    db.saveCollection(collection, items);
    return items[idx];
  },

  delete: (collection, id) => {
    const items = db.getCollection(collection);
    const filtered = items.filter(x => x.id !== id);
    db.saveCollection(collection, filtered);
    return true;
  },

  logActivity: (userId, action, details) => {
    db.insert('activity_logs', {
      user_id: userId,
      action,
      details
    });
  },

  sendNotification: (userId, title, message) => {
    db.insert('notifications', {
      user_id: userId,
      title,
      message,
      is_read: false
    });
  }
};

module.exports = db;
