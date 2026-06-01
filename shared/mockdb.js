/**
 * Minimal in-memory stand-in for Mongoose models (MOCK_DB=true).
 * Supports the subset of the API this app uses: find/findOne/findById/create/
 * countDocuments/findOneAndUpdate/findByIdAndUpdate/updateOne/updateMany/
 * deleteOne/deleteMany and a small aggregate ($match/$group/$sort/$limit).
 * Not a full Mongoose — good enough for UI demos without MongoDB.
 */
let _id = 1;
function oid() { return (Date.now().toString(16) + (_id++).toString(16).padStart(6, '0')).padStart(24, '0').slice(-24); }

function matchValue(docVal, cond) {
  if (cond && typeof cond === 'object' && !(cond instanceof RegExp) && !Array.isArray(cond)) {
    for (const [op, v] of Object.entries(cond)) {
      switch (op) {
        case '$in': if (!v.map(String).includes(String(docVal))) return false; break;
        case '$nin': if (v.map(String).includes(String(docVal))) return false; break;
        case '$gte': if (!(docVal >= v)) return false; break;
        case '$lte': if (!(docVal <= v)) return false; break;
        case '$gt': if (!(docVal > v)) return false; break;
        case '$lt': if (!(docVal < v)) return false; break;
        case '$ne': if (String(docVal) === String(v)) return false; break;
        case '$regex': { const re = v instanceof RegExp ? v : new RegExp(v, cond.$options || ''); if (!re.test(String(docVal == null ? '' : docVal))) return false; break; }
        case '$exists': if ((docVal !== undefined) !== v) return false; break;
        default: break;
      }
    }
    return true;
  }
  if (cond instanceof RegExp) return cond.test(String(docVal == null ? '' : docVal));
  if (cond === null) return docVal == null;
  return String(docVal) === String(cond);
}

function matches(doc, query) {
  if (!query) return true;
  for (const [k, cond] of Object.entries(query)) {
    if (k === '$or') { if (!cond.some((q) => matches(doc, q))) return false; continue; }
    if (k === '$and') { if (!cond.every((q) => matches(doc, q))) return false; continue; }
    if (!matchValue(doc[k], cond)) return false;
  }
  return true;
}

function applyUpdate(doc, update) {
  for (const [op, fields] of Object.entries(update)) {
    if (op === '$set') Object.assign(doc, fields);
    else if (op === '$inc') for (const [f, v] of Object.entries(fields)) doc[f] = (doc[f] || 0) + v;
    else if (op === '$push') for (const [f, v] of Object.entries(fields)) (doc[f] = doc[f] || []).push(v);
    else if (!op.startsWith('$')) doc[op] = fields; // bare field assignment
  }
  doc.updatedAt = new Date();
  return doc;
}

function makeMockModel(name, schema) {
  const store = [];
  const defaults = {};
  for (const p of Object.keys(schema.paths)) {
    const dv = schema.paths[p].options ? schema.paths[p].options.default : undefined;
    if (dv !== undefined) defaults[p] = dv;
  }
  function instantiate(doc) {
    const base = {};
    for (const [k, v] of Object.entries(defaults)) base[k] = typeof v === 'function' ? v() : (Array.isArray(v) ? [] : (v && typeof v === 'object' ? {} : v));
    const o = Object.assign(base, doc);
    if (!o._id) o._id = oid();
    o.createdAt = o.createdAt || new Date();
    o.updatedAt = new Date();
    o.save = async () => { if (!store.includes(o)) store.push(o); return o; };
    o.toObject = () => o;
    return o;
  }

  // chainable array result
  function arrayQuery(filterFn) {
    let rows = store.filter(filterFn);
    const q = {
      sort(s) { const k = Object.keys(s)[0]; const dir = s[k] < 0 ? -1 : 1; rows = rows.slice().sort((a, b) => (a[k] > b[k] ? 1 : a[k] < b[k] ? -1 : 0) * dir); return q; },
      limit(n) { rows = rows.slice(0, n); return q; },
      skip(n) { rows = rows.slice(n); return q; },
      lean() { return q; },
      exec() { return Promise.resolve(rows); },
      then(res, rej) { return Promise.resolve(rows).then(res, rej); },
    };
    return q;
  }
  function singleQuery(getter) {
    const q = {
      lean() { return q; }, exec() { return Promise.resolve(getter()); },
      then(res, rej) { return Promise.resolve(getter()).then(res, rej); },
    };
    return q;
  }

  return {
    modelName: name,
    _store: store,
    find(query = {}) { return arrayQuery((d) => matches(d, query)); },
    findOne(query = {}) { return singleQuery(() => store.find((d) => matches(d, query)) || null); },
    findById(id) { return singleQuery(() => store.find((d) => String(d._id) === String(id)) || null); },
    async create(doc) {
      if (Array.isArray(doc)) return doc.map((d) => { const o = instantiate(d); store.push(o); return o; });
      const o = instantiate(doc); store.push(o); return o;
    },
    async countDocuments(query = {}) { return store.filter((d) => matches(d, query)).length; },
    async findOneAndUpdate(query, update, opts = {}) {
      let doc = store.find((d) => matches(d, query));
      if (!doc) { if (opts.upsert) { doc = instantiate(typeof query === 'object' ? { ...query } : {}); store.push(doc); } else return null; }
      applyUpdate(doc, update);
      return opts.new === false ? null : doc;
    },
    async findByIdAndUpdate(id, update, opts = {}) {
      const doc = store.find((d) => String(d._id) === String(id));
      if (!doc) return null; applyUpdate(doc, update); return doc;
    },
    async updateOne(query, update) { const d = store.find((x) => matches(x, query)); if (d) applyUpdate(d, update); return { modifiedCount: d ? 1 : 0 }; },
    async updateMany(query, update) { let n = 0; store.forEach((d) => { if (matches(d, query)) { applyUpdate(d, update); n++; } }); return { modifiedCount: n }; },
    async deleteOne(query) { const i = store.findIndex((d) => matches(d, query)); if (i >= 0) store.splice(i, 1); return { deletedCount: i >= 0 ? 1 : 0 }; },
    async deleteMany(query = {}) { let n = 0; for (let i = store.length - 1; i >= 0; i--) if (matches(store[i], query)) { store.splice(i, 1); n++; } return { deletedCount: n }; },
    async aggregate(pipeline) {
      let rows = store.slice();
      for (const stage of pipeline) {
        if (stage.$match) rows = rows.filter((d) => matches(d, stage.$match));
        else if (stage.$group) {
          const g = stage.$group; const groups = new Map();
          for (const d of rows) {
            const key = g._id == null ? 'null' : String(d[String(g._id).replace('$', '')]);
            if (!groups.has(key)) groups.set(key, { _id: g._id == null ? null : d[String(g._id).replace('$', '')] });
            const acc = groups.get(key);
            for (const [f, expr] of Object.entries(g)) {
              if (f === '_id') continue;
              if (expr && expr.$sum) acc[f] = (acc[f] || 0) + (typeof expr.$sum === 'number' ? expr.$sum : (d[String(expr.$sum).replace('$', '')] || 0));
            }
          }
          rows = Array.from(groups.values());
        } else if (stage.$sort) { const k = Object.keys(stage.$sort)[0]; const dir = stage.$sort[k] < 0 ? -1 : 1; rows.sort((a, b) => (a[k] > b[k] ? 1 : a[k] < b[k] ? -1 : 0) * dir); }
        else if (stage.$limit) rows = rows.slice(0, stage.$limit);
      }
      return rows;
    },
  };
}

module.exports = { makeMockModel };
