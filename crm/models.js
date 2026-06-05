/**
 * crm/models.js — CRM-only collections, registered on the shared mongoose instance
 * from ../db (same smpp_bridge database the bridge/admin/portal use).
 *
 * Core billing models (User, Invoice, Payment, CreditTransaction, UsageEvent)
 * live in ../db and are reused — these are the relationship-management extras.
 */
const db = require('../db');
const { Schema } = db.mongoose;

// One profile per client (keyed by username) — the "R" in CRM.
const CrmProfileSchema = new Schema({
  username: { type: String, required: true, unique: true, lowercase: true, trim: true },
  user_id: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  company: { type: String, default: '' },
  contact_name: { type: String, default: '' },
  email: { type: String, default: '' },
  phone: { type: String, default: '' },
  telegram: { type: String, default: '' },
  whatsapp: { type: String, default: '' },
  country: { type: String, default: '' },
  address: { type: String, default: '' },
  vat_id: { type: String, default: '' },
  tags: { type: [String], default: [] },
  source: { type: String, default: '' }, // where this client came from
}, { timestamps: true });

// Timeline entries + tasks, attached to a client (ref=username) or a lead (ref=lead id).
const CrmActivitySchema = new Schema({
  ref_type: { type: String, enum: ['client', 'lead'], required: true, index: true },
  ref_id: { type: String, required: true, index: true }, // username for clients, lead _id for leads
  ref_name: { type: String, default: '' },               // display name (denormalized for the tasks list)
  kind: { type: String, enum: ['note', 'call', 'meeting', 'email', 'task', 'system'], default: 'note' },
  body: { type: String, default: '' },
  due_at: { type: Date, default: null, index: true },    // set => it's a follow-up/task
  done: { type: Boolean, default: false, index: true },
  done_at: { type: Date, default: null },
  reminded: { type: Boolean, default: false },           // Telegram reminder fired
  by: { type: String, default: 'admin' },
}, { timestamps: true });
CrmActivitySchema.index({ ref_type: 1, ref_id: 1, createdAt: -1 });

// Sales pipeline — prospects before they become Users.
const CrmLeadSchema = new Schema({
  name: { type: String, required: true },
  company: { type: String, default: '' },
  email: { type: String, default: '' },
  phone: { type: String, default: '' },
  telegram: { type: String, default: '' },
  whatsapp: { type: String, default: '' },
  country: { type: String, default: '' },
  source: { type: String, default: '' },
  stage: { type: String, enum: ['new', 'contacted', 'negotiating', 'won', 'lost'], default: 'new', index: true },
  est_value: { type: Number, default: 0 },               // expected monthly EUR
  est_volume: { type: Number, default: 0 },              // expected SMS/month
  next_follow_up: { type: Date, default: null, index: true },
  fu_reminded: { type: Boolean, default: false },
  lost_reason: { type: String, default: '' },
  converted_username: { type: String, default: '' },     // set when won → client created
  notes: { type: String, default: '' },                  // quick free-form summary (timeline lives in CrmActivity)
}, { timestamps: true });

// A pending USDT (TRC-20) top-up: unique amount → watch the wallet → auto-confirm.
const CryptoIntentSchema = new Schema({
  username: { type: String, required: true, index: true },
  user_id: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  eur: { type: Number, required: true },                 // EUR the client is buying
  usdt: { type: Number, required: true },                // unique USDT amount to send (6 dp)
  usdt_str: { type: String, required: true, index: true }, // exact 6-dp string for on-chain matching
  rate: { type: Number, required: true },                // EUR per 1 USDT used
  wallet: { type: String, required: true },              // our TRC-20 address
  // 'topup' = balance top-up; 'invoice' = settles a specific manual invoice on arrival
  purpose: { type: String, enum: ['topup', 'invoice'], default: 'topup', index: true },
  target_invoice_id: { type: Schema.Types.ObjectId, ref: 'Invoice', default: null },
  target_invoice_number: { type: String, default: '' },
  status: { type: String, enum: ['pending', 'paid', 'expired', 'cancelled'], default: 'pending', index: true },
  // near-miss detection: a tx close to (but not exactly) this amount was seen on-chain
  suspect_txid: { type: String, default: '' },
  suspect_usdt: { type: Number, default: 0 },
  suspect_at: { type: Date, default: null },
  txid: { type: String, default: '' },
  paid_at: { type: Date, default: null },
  payment_id: { type: Schema.Types.ObjectId, ref: 'Payment', default: null },
  invoice_number: { type: String, default: '' },
  expires_at: { type: Date, required: true, index: true },
  by: { type: String, default: 'admin' },
}, { timestamps: true });

// Support tickets — a conversation thread with a client/contact, often spawned from an email.
const TicketSchema = new Schema({
  number: { type: String, required: true, unique: true },   // T-0001
  subject: { type: String, default: '(no subject)' },
  client_username: { type: String, default: '', index: true }, // linked CRM client, if any
  contact_email: { type: String, default: '', index: true },   // who we're talking to
  contact_name: { type: String, default: '' },
  status: { type: String, enum: ['open', 'pending', 'closed'], default: 'open', index: true },
  priority: { type: String, enum: ['low', 'normal', 'high'], default: 'normal' },
  source: { type: String, enum: ['email', 'manual'], default: 'manual' },
  assignee: { type: String, default: '' },
  messages: [new Schema({
    dir: { type: String, enum: ['in', 'out', 'note'], default: 'note' },
    from: { type: String, default: '' },
    body: { type: String, default: '' },
    at: { type: Date, default: Date.now },
    by: { type: String, default: '' },
  }, { _id: true })],
  last_message_id: { type: String, default: '' },           // for email reply threading (In-Reply-To)
  references: { type: String, default: '' },
  last_at: { type: Date, default: Date.now, index: true },
}, { timestamps: true });

const defs = {
  CrmProfile: CrmProfileSchema,
  CrmActivity: CrmActivitySchema,
  CrmLead: CrmLeadSchema,
  CryptoIntent: CryptoIntentSchema,
  Ticket: TicketSchema,
};

const models = {};
if (db.MOCK) {
  const { makeMockModel } = require('../shared/mockdb');
  for (const [name, schema] of Object.entries(defs)) models[name] = makeMockModel(name, schema);
} else {
  for (const [name, schema] of Object.entries(defs)) models[name] = db.mongoose.model(name, schema);
}

module.exports = models;
