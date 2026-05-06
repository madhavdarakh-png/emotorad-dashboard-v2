"use strict";
const https = require("https");
const crypto = require("crypto");

const SPREADSHEET_ID = "1UQ04ooxEWq8nExhu5ksVDYIaddFpzgKZO7FouwSu1rE";
const SOURCE_GID     = 1516006436;
const SCOPES         = "https://www.googleapis.com/auth/spreadsheets.readonly";

const CANONICAL_SKUS = [
  "Dope", "X1", "X2", "ST-X", "Legend 07", "X3",
  "Viper", "T-Rex Air", "T-Rex Pro", "Doodle", "EMX+", "Cargo G1", "Lil E"
];

const SKU_NORM = {
  "dope": "Dope",
  "x1": "X1", "sn1": "X1",
  "x1 7.65 ah": "X1", "x1 7.65ah": "X1",
  "x1 10.2 ah": "X1", "x1 10.2ah": "X1",
  "x2": "X2",
  "x3": "X3",
  "stx": "ST-X", "st x": "ST-X", "st-x": "ST-X",
  "legend": "Legend 07", "legend 07": "Legend 07",
  "viper": "Viper",
  "trex air": "T-Rex Air", "t rex air": "T-Rex Air", "t-rex air": "T-Rex Air",
  "t rex smart": "T-Rex Air",
  "t rex pro": "T-Rex Pro", "trex pro": "T-Rex Pro", "t-rex pro": "T-Rex Pro",
  "doodle": "Doodle", "doodle v4": "Doodle", "doodle v3": "Doodle",
  "t rex+": "EMX+", "t-rex+": "EMX+", "emx+": "EMX+",
  "cargo": "Cargo G1", "g1": "Cargo G1", "cargo g1": "Cargo G1",
  "lil e": "Lil E",
};

const MATERIAL_COST_PER_SKU = {
  "Dope":0,"X1":0,"X2":0,"ST-X":0,"Legend 07":0,"X3":0,
  "Viper":0,"T-Rex Air":0,"T-Rex Pro":0,"Doodle":0,"EMX+":0,"Cargo G1":0,"Lil E":0,
};

const MONTHS = {
  january:1,february:2,march:3,april:4,may:5,june:6,
  july:7,august:8,september:9,october:10,november:11,december:12
};

function b64url(buf) {
  return buf.toString("base64").replace(/[+]/g,"-").replace(/[/]/g,"_").replace(/[=]/g,"");
}

function makeJWT(sa) {
  const now = Math.floor(Date.now()/1000);
  const h   = b64url(Buffer.from(JSON.stringify({alg:"RS256",typ:"JWT"})));
  const p   = b64url(Buffer.from(JSON.stringify({
    iss: sa.client_email, scope: SCOPES,
    aud: "https://oauth2.googleapis.com/token",
    iat: now, exp: now+3600
  })));
  const msg = h+"."+p;
  const sig = b64url(crypto.sign("sha256", Buffer.from(msg), crypto.createPrivateKey(sa.private_key)));
  return msg+"."+sig;
}

function getToken(sa) {
  return new Promise(function(resolve,reject) {
    const jwt  = makeJWT(sa);
    const body = "grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion="+jwt;
    const req  = https.request({
      hostname:"oauth2.googleapis.com", path:"/token", method:"POST",
      headers:{"Content-Type":"application/x-www-form-urlencoded","Content-Length":Buffer.byteLength(body)}
    }, function(res){ var d=""; res.on("data",function(c){d+=c;}); res.on("end",function(){
      try { var j=JSON.parse(d); j.access_token?resolve(j.access_token):reject(new Error("No access_token: "+d.slice(0,300))); }
      catch(e){ reject(new Error("OAuth parse error: "+d.slice(0,300))); }
    }); });
    req.on("error",reject); req.write(body); req.end();
  });
}

function httpsGet(url, token) {
  return new Promise(function(resolve,reject) {
    const opts = new URL(url);
    const req  = https.request({
      hostname: opts.hostname, path: opts.pathname+opts.search,
      headers: {Authorization:"Bearer "+token}
    }, function(res){ var d=""; res.on("data",function(c){d+=c;}); res.on("end",function(){resolve(d);}); });
    req.on("error",reject); req.end();
  });
}

function parseDateStr(s) {
  const n = typeof s === "number" ? s : (typeof s === "string" && /^\d+(\.\d+)?$/.test(s.trim()) ? parseFloat(s.trim()) : NaN);
  if(!isNaN(n) && n > 1000 && n < 200000) {
    const d = new Date(Date.UTC(1899, 11, 30) + Math.floor(n) * 86400000);
    return d.toISOString().slice(0, 10);
  }
  s = String(s||"").trim();
  if(/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const dmy = s.match(/^(\d{1,2})[-\/](\d{1,2})[-\/](\d{4})$/);
  if(dmy) return dmy[3]+"-"+String(parseInt(dmy[2])).padStart(2,"0")+"-"+String(parseInt(dmy[1])).padStart(2,"0");
  const m = s.match(/^(\w+)\s+(\d+)[,\s]+(\d{4})$/i);
  if(!m) return null;
  const mo = MONTHS[m[1].toLowerCase()];
  if(!mo) return null;
  return m[3]+"-"+String(mo).padStart(2,"0")+"-"+String(parseInt(m[2])).padStart(2,"0");
}

function normalizeSKU(raw) {
  if(!raw) return null;
  raw = raw.trim();
  const key     = raw.toLowerCase().replace(/[-]+/g," ").replace(/\s+/g," ").trim();
  const compact = raw.toLowerCase().replace(/[\s-]/g,"");
  if(SKU_NORM[key])     return SKU_NORM[key];
  if(SKU_NORM[compact]) return SKU_NORM[compact];
  if(/\bx2\b/.test(key)) return "X2";
  return raw;
}

module.exports = async function(req, res) {
  res.setHeader("Cache-Control","no-store,no-cache,must-revalidate");
  res.setHeader("Access-Control-Allow-Origin","*");
  res.setHeader("Access-Control-Allow-Methods","GET,OPTIONS");
  if(req.method==="OPTIONS"){ res.status(200).end(); return; }

  const rawSA = process.env.GOOGLE_SA_JSON || "";
  let sa;
  try {
    sa = JSON.parse(rawSA);
  } catch(parseErr) {
    return res.status(500).json({
      error: "GOOGLE_SA_JSON parse failed: "+parseErr.message,
      sa_length: rawSA.length, node: process.version
    });
  }
  if(!sa || !sa.private_key || !sa.client_email) {
    return res.status(500).json({
      error: "GOOGLE_SA_JSON missing required fields",
      keys: sa ? Object.keys(sa) : [], node: process.version
    });
  }

  try {
    const token = await getToken(sa);

    const meta = JSON.parse(await httpsGet(
      "https://sheets.googleapis.com/v4/spreadsheets/"+SPREADSHEET_ID+"?fields=sheets(properties(sheetId,title))", token
    ));
    let sheetTitle = null;
    for(const s of (meta.sheets||[])) {
      if(s.properties.sheetId===SOURCE_GID){ sheetTitle=s.properties.title; break; }
    }
    if(!sheetTitle) throw new Error("Sheet GID "+SOURCE_GID+" not found. meta="+JSON.stringify(meta).slice(0,200));

    const data   = JSON.parse(await httpsGet(
      "https://sheets.googleapis.com/v4/spreadsheets/"+SPREADSHEET_ID+
      "/values/"+encodeURIComponent(sheetTitle)+"?valueRenderOption=UNFORMATTED_VALUE", token
    ));
    const values = data.values || [];

    const channelMap = {}, skuMap = {}, channels = [], skus = [], rows = [], dates = new Set();

    for(let i=4; i<values.length; i++) {
      const row = values[i];
      if(!row || row.length < 15) continue;
      const channel = String(row[2]||"").trim();
      const dateRaw = row[11];
      const type    = String(row[12]||"").trim();
      const model   = normalizeSKU(String(row[14]||"").trim());
      const qty     = parseFloat(row[17]) || 0;
      const rev     = parseFloat(row[19]) || 0;
      if(!channel || !model)                      continue;
      if(type.toLowerCase().includes("accessor")) continue;
      if(qty===0 && rev===0)                      continue;
      const dateStr = parseDateStr(dateRaw);
      if(!dateStr) continue;
      if(channelMap[channel]===undefined){ channelMap[channel]=channels.length; channels.push(channel); }
      if(skuMap[model]===undefined)      { skuMap[model]=skus.length;           skus.push(model);       }
      dates.add(dateStr);
      const matCost = (MATERIAL_COST_PER_SKU[model] || 0) * qty;
      rows.push([dateStr, channelMap[channel], skuMap[model], qty, Math.round(rev*100)/100, matCost]);
    }

    const sortedDates = Array.from(dates).sort();
    return res.status(200).json({
      generated_at:   new Date().toISOString(),
      channels, skus, rows,
      rowCount:       rows.length,
      availableYears: [...new Set(sortedDates.map(d=>d.slice(0,4)))],
      availableMonths:[...new Set(sortedDates.map(d=>d.slice(0,7)))],
      availableDays:  sortedDates,
      sourceSheetId:  SPREADSHEET_ID,
      sourceGid:      SOURCE_GID,
      sheetTitle,
      materialCostConfig: MATERIAL_COST_PER_SKU,
      canonicalSkus:      CANONICAL_SKUS,
    });

  } catch(e) {
    return res.status(500).json({ error: e.message, stack: e.stack });
  }
};
