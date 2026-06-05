/**
 * gen-templates.js — builds crm/auto-templates.json: a large, varied library of
 * transactional-style SMS templates for Nepali small businesses (the ones that
 * have a website: small e-commerce, online clothing, dental clinics, education
 * consultancies, gaming top-up, digital products, salons, gyms, institutes…).
 *
 * Each template carries an XXXXXX code placeholder (a run of X's) which the engine
 * replaces with the client's numeric code (any 4–10 digit length). Messages are
 * matched to a business category so they read naturally, then deduped + shuffled.
 *
 *   node crm/gen-templates.js          # writes the JSON
 */
const fs = require('fs');
const path = require('path');

// User-provided seed examples (kept verbatim).
const SEED = [
  "XXXXXXX is your unipin code .",
  "XXXXXXXX is your code to login to GameMandu",
  "Gamehub Nepal: your GARENA redeem code is XXXXXXXX shhhh don't share it !!",
  "ETG: Thankyou for Enrolling with us your student id is XXXXXXXX",
  "AECC : Did you score above 5.0 ? check using your student code :XXXXXXXX",
  "The Next Education : congratulations on your test scholarship use the code to view : XXXXXXXX",
  "XXXXXXXX is your access code to zoom global.",
  "ETG : XXXXXXXX is your password for zoom mock test (education tree global )",
  "Orion Nexus tech : your order id XXXXXXXX is cancelled . Login to view.",
  "Digital Product Nepal: XXXXXXXX is your activation code for canvas premium .",
  "Hamro digital Sewa : Redeem your coupon code with this number : XXXXXXXX",
  "HexXone : here is your activation code XXXXXXXXX",
  "Cheap Mandu : XXXXXXXX is your order id .",
];

// Businesses by category (invented but plausible Nepali small brands).
const BIZ = {
  clothing: ['Threadku', 'Kapada Ghar', 'Newa Threads', 'Style Mandu', 'Hamro Closet', 'Trendy Nepal', 'Cotton Yeti', 'Bagmati Wears', 'Pashmina Co', 'Urban Lai', 'Fashion Bazar NP', 'Sherpa Stitches', 'Dressmandu', 'Lukla Apparel'],
  ecommerce: ['Cheap Mandu', 'Sasto Deal NP', 'Quick Kart', 'Himal Mart', 'Everest Cart', 'Yak Bazaar', 'Buy Nepal', 'Karobar Online', 'Nepa Store', 'Order Nepal', 'Daju Deals', 'Sajilo Shop'],
  dental: ['Smile Dental Care', 'Kathmandu Dental', 'Pearl Dental', 'Himalaya Dental', 'City Dental Clinic', 'Bright Smile NP', 'Newroad Dental', 'Ortho Care Nepal', 'Sworga Dental', 'Aarogya Dental'],
  consultancy: ['ETG', 'AECC', 'Global Reach', 'KIEC', 'Study Mate', 'Visa Path NP', 'Aspire Consultancy', 'Eduwise', 'The Next Education', 'Career Hub', 'Alpha Beta Edu', 'Foreign Path'],
  gaming: ['GameMandu', 'Gamehub Nepal', 'UniPin', 'TopUp Nepal', 'Esports Nepal', 'Diamond Store NP', 'Redeem Nepal', 'GG TopUp', 'Pubg Mandu', 'FreeFire NP'],
  digital: ['Digital Product Nepal', 'Hamro Digital Sewa', 'HexXone', 'Orion Nexus', 'Premium Mandu', 'Subscription Nepal', 'OTT Nepal', 'Account Bazar', 'Canva Reseller NP'],
  salon: ['Glow Salon', 'Beauty Mandu', 'Lavanya Spa', 'Herbal Glow', 'Style Studio NP', 'Makeover Nepal'],
  gym: ['Flex Gym', 'Iron Mandu', 'FitNepal', 'Powerhouse Gym', 'Body Forge NP'],
  institute: ['Bridge Course NP', 'Pinnacle Academy', 'Genius Tuition', 'Merit Institute', 'Brainfield', 'Excel Academy', 'Language Mandu', 'Spoken English NP'],
  travel: ['Yeti Trails', 'Trek Nepal', 'Himal Tours', 'Booking Mandu', 'Annapurna Travels'],
  electronics: ['Gadget Bazar', 'Tech Mandu', 'Hamro Electronics', 'Daju Gadgets', 'Circuit Nepal'],
  food: ['Tiffin Nepal', 'Momo Hub', 'Cloud Kitchen NP', 'Bhojan Express', 'Foodmandu Lite'],
};

// Category -> message formats. {N} = business name, XXX = code placeholder (run length varied).
const FORMATS = {
  clothing: [
    "{N}: XXXXXX is your verification code. Do not share it.",
    "XXXXXXX is your code to login to {N}.",
    "{N}: your order id is XXXXXXXX. Login to track your parcel.",
    "{N}: your order XXXXXXXX has been confirmed. Thank you for shopping!",
    "{N}: redeem your festive coupon with this code: XXXXXX.",
    "{N}: your return request XXXXXXX is approved. Login to view.",
    "{N}: XXXXXX is your one-time code to checkout. Valid 10 min.",
  ],
  ecommerce: [
    "{N} : XXXXXXXX is your order id .",
    "{N}: your order XXXXXXXX is cancelled. Login to view.",
    "XXXXXX is your {N} login code. Keep it private.",
    "{N}: your shipment XXXXXXX is out for delivery.",
    "{N}: use XXXXXX to confirm your cash-on-delivery order.",
    "{N}: your refund for order XXXXXXXX is processed.",
    "{N}: XXXXXX is your OTP. Never share it with anyone.",
  ],
  dental: [
    "{N}: your appointment reference number is XXXXXX.",
    "{N}: XXXXXX confirms your booking. See you soon!",
    "{N}: use code XXXXXX to reschedule your appointment online.",
    "{N}: your patient id is XXXXXXXX. Login to view your reports.",
    "{N}: XXXXXX is your verification code for your online booking.",
    "{N}: your check-up token number is XXXXXX.",
  ],
  consultancy: [
    "{N}: Thank you for enrolling. Your student id is XXXXXXXX.",
    "{N}: XXXXXXXX is your access code to the mock test portal.",
    "{N}: check your result using your student code: XXXXXXXX.",
    "{N}: XXXXXXXX is your password for the online class. Do not share.",
    "{N}: congratulations! Use code XXXXXXXX to view your scholarship.",
    "{N}: your counselling reference number is XXXXXX.",
    "XXXXXXXX is your access code to {N} student dashboard.",
  ],
  gaming: [
    "{N}: your redeem code is XXXXXXXX. Shhh, don't share it!",
    "XXXXXXXX is your code to login to {N}.",
    "{N}: your top-up id is XXXXXXX. Diamonds added successfully.",
    "{N}: XXXXXXXX is your gift card pin. Keep it secret.",
    "{N}: use XXXXXX to verify your top-up. Valid for 5 min.",
    "{N}: your voucher code is XXXXXXXX. Happy gaming!",
  ],
  digital: [
    "{N}: XXXXXXXX is your activation code. Login to redeem.",
    "{N}: redeem your coupon with this number: XXXXXXXX.",
    "{N}: here is your activation code XXXXXXXXX.",
    "{N}: XXXXXX is your subscription pin. Do not share.",
    "{N}: your order XXXXXXXX is ready. Login to collect your code.",
    "XXXXXX is your one-time password for {N}.",
  ],
  salon: [
    "{N}: your appointment reference number is XXXXXX.",
    "{N}: XXXXXX confirms your booking. Looking forward to pampering you!",
    "{N}: use XXXXXX to redeem your loyalty reward.",
    "{N}: your membership id is XXXXXXXX. Welcome!",
  ],
  gym: [
    "{N}: your membership id is XXXXXXXX. Welcome aboard!",
    "{N}: XXXXXX is your check-in code for today.",
    "{N}: use code XXXXXX to renew your membership online.",
    "{N}: XXXXXX is your verification code. Stay strong!",
  ],
  institute: [
    "{N}: your enrollment code is XXXXXXXX. Welcome to the batch!",
    "{N}: XXXXXXXX is your login password for the class portal.",
    "{N}: your roll number is XXXXXX. Login to view your routine.",
    "{N}: use XXXXXX to access your study material.",
    "{N}: XXXXXX is your one-time code for the online exam.",
  ],
  travel: [
    "{N}: your booking reference is XXXXXXXX. Bon voyage!",
    "{N}: XXXXXX confirms your reservation. Login for details.",
    "{N}: use XXXXXX to verify your booking.",
    "{N}: your ticket number is XXXXXXXX.",
  ],
  electronics: [
    "{N}: your order id is XXXXXXXX. Login to track.",
    "{N}: XXXXXX is your warranty registration code.",
    "{N}: your repair ticket number is XXXXXX.",
    "{N}: XXXXXX is your OTP. Do not share it.",
  ],
  food: [
    "{N}: your order XXXXXXXX is confirmed and being prepared.",
    "{N}: XXXXXX is your delivery verification code.",
    "{N}: use XXXXXX to redeem your free delivery coupon.",
    "{N}: your order id is XXXXXXX. Bon appetit!",
  ],
};

const out = new Set(SEED);
for (const [cat, names] of Object.entries(BIZ)) {
  const fmts = FORMATS[cat] || [];
  for (const name of names) for (const f of fmts) out.add(f.replace('{N}', name));
}

// Shuffle (Fisher–Yates) for a non-repetitive order; trim to a round number ≥ 200.
const arr = [...out];
for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; }

const file = path.join(__dirname, 'auto-templates.json');
fs.writeFileSync(file, JSON.stringify(arr, null, 0));
console.log(`wrote ${arr.length} templates -> ${file}`);
