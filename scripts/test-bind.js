// Bind to the bridge as the demo client, submit a message, wait for the DLR.
const smpp = require('smpp');
const session = smpp.connect({ url: 'smpp://127.0.0.1:2775' });
session.on('connect', () => {
  session.bind_transceiver({ system_id: 'demo', password: 'demo123' }, (pdu) => {
    if (pdu.command_status !== 0) { console.log('BIND FAILED', smpp.errors[pdu.command_status]); process.exit(1); }
    console.log('BOUND ok');
    session.submit_sm({ source_addr: 'BRIDGE', destination_addr: '9779812345678', short_message: 'Hello via bridge!', registered_delivery: 1 }, (p) => {
      console.log('SUBMIT_RESP status=' + p.command_status + ' message_id=' + p.message_id);
    });
  });
});
session.on('deliver_sm', (pdu) => {
  session.send(pdu.response());
  const t = pdu.short_message && pdu.short_message.message ? pdu.short_message.message.toString() : '';
  console.log('DLR:', t);
  setTimeout(() => process.exit(0), 200);
});
session.on('error', (e) => { console.log('ERR', e.message); process.exit(1); });
setTimeout(() => { console.log('timeout (no DLR)'); process.exit(2); }, 8000);
