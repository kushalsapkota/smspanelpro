/**
 * run_ui_only.js — boot just the admin panel + client portal (no SMPP server).
 * Handy for previewing the UI. Pair with MOCK_DB=true to run with no MongoDB.
 *   MOCK_DB=true node run_ui_only.js
 */
require('dotenv').config();
require('./admin/server');
require('./portal/server');
console.log('[ui-only] admin + portal starting (no SMPP server)');
