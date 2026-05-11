"use strict";
const https  = require("https");
const crypto = require("crypto");

const SPREADSHEET_ID = "1UQ04ooxEWq8nExhu5ksVDYIaddFpzgKZO7FouwSu1rE";
const DEALER_SHEET   = "Dealer Level Sales";
const SCOPES         = "https://www.googleapis.com/auth/spreadsheets.readonly";

function b64url(buf){
  return buf.toString("base64").replace(/[+]/g,"-").replace(/[/]/g,"_").replace(/[=]/g,"");
}
function makeJWT(sa){
  const now=Math.floor(Date.now()/1000);
  const h=b64url(Buffer.from(JSON.stringify({alg:"RS256",typ:"JWT"})));
  const p=b64url(Buffer.from(JSON.stringify({iss:sa.client_email,scope:SCOPES,aud:"https://oauth2.googleapis.com/token",iat:now,exp:now+3600})));
  const msg=h+"."+p;
  const sig=b64url(crypto.sign("sha256",Buffer.from(msg),crypto.createPrivateKey(sa.private_key)));
  return msg+"."+sig;
}
function getToken(sa){
  return new Promise(function(resolve,reject){
    const jwt=makeJWT(sa);
    const body="grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion="+jwt;
    const req=https.request({hostname:"oauth2.googleapis.com",path:"/token",method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded","Content-Length":Buffer.byteLength(body)}},function(res){var d="";res.on("data",function(c){d+=c;});res.on("end",function(){try{var j=JSON.parse(d);j.access_token?resolve(j.access_token):reject(new Error("No token"));}catch(e){reject(e);}});});
    req.on("error",reject);req.write(body);req.end();
  });
}
function httpsGet(url,token){
  return new Promise(function(resolve,reject){
    const u=new URL(url);
    const req=https.request({hostname:u.hostname,path:u.pathname+u.search,headers:{Authorization:"Bearer "+token}},function(res){var d="";res.on("data",function(c){d+=c;});res.on("end",function(){resolve(d);});});
    req.on("error",reject);req.end();
  });
}
function parseDateVal(v){
  if(typeof v==="number"&&v>1000&&v<300000){return new Date(Date.UTC(1899,11,30)+Math.floor(v)*86400000).toISOString().slice(0,10);}
  const s=String(v||"").trim();
  if(/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(s))return s;
  const dmy=s.match(/^([0-9]{1,2})[/-]([0-9]{1,2})[/-]([0-9]{4})$/);
  if(dmy)return dmy[3]+"-"+String(parseInt(dmy[2])).padStart(2,"0")+"-"+String(parseInt(dmy[1])).padStart(2,"0");
  return null;
}

module.exports=async function(req,res){
  res.setHeader("Cache-Control","no-store,no-cache,must-revalidate");
  res.setHeader("Access-Control-Allow-Origin","*");
  res.setHeader("Access-Control-Allow-Methods","GET,OPTIONS");
  if(req.method==="OPTIONS"){res.status(200).end();return;}
  const rawSA=process.env.GOOGLE_SA_JSON||"";
  let sa;
  try{sa=JSON.parse(rawSA);}catch(e){return res.status(500).json({error:"SA parse failed: "+e.message});}
  if(!sa||!sa.private_key||!sa.client_email)return res.status(500).json({error:"SA missing fields"});
  try{
    const token=await getToken(sa);
    const raw=await httpsGet("https://sheets.googleapis.com/v4/spreadsheets/"+SPREADSHEET_ID+"/values/"+encodeURIComponent(DEALER_SHEET)+"?valueRenderOption=UNFORMATTED_VALUE",token);
    const values=(JSON.parse(raw).values)||[];
    if(values.length<2)throw new Error("No data in: "+DEALER_SHEET);
    const hdr=values[0].map(function(h){return String(h||"").trim().toLowerCase();});
    let catIdx=-1,dateIdx=-1,dealerIdx=-1,regionIdx=-1,modelIdx=-1,qtyIdx=-1,rateIdx=-1,taxIdx=-1;
    for(let i=0;i<hdr.length;i++){
      const h=hdr[i];
      if(h==="category"&&catIdx===-1)catIdx=i;
      else if(h.includes("invoice date")&&dateIdx===-1)dateIdx=i;
      else if((h==="bill to"||h.startsWith("bill to"))&&dealerIdx===-1)dealerIdx=i;
      else if(h==="region"&&regionIdx===-1)regionIdx=i;
      else if(h==="model"&&modelIdx===-1)modelIdx=i;
      else if((h==="qty"||h==="quantity")&&qtyIdx===-1)qtyIdx=i;
      else if(h.includes("net sales rate")&&rateIdx===-1)rateIdx=i;
      else if(h.includes("taxable value")&&taxIdx===-1)taxIdx=i;
    }
    const rows=[];const dates=new Set();
    for(let r=1;r<values.length;r++){
      const row=values[r];if(!row||!row.length)continue;
      const cat=String(row[catIdx]||"").trim();
      if(cat!=="Dealer"&&cat!=="Distributor")continue;
      const ds=parseDateVal(row[dateIdx]);if(!ds)continue;
      const qty=parseFloat(row[qtyIdx])||0,tax=parseFloat(row[taxIdx])||0;
      if(qty===0&&tax===0)continue;
      dates.add(ds);
      rows.push([ds,cat,String(row[dealerIdx]||"").trim(),String(row[regionIdx]||"").trim(),String(row[modelIdx]||"").trim(),qty,Math.round((parseFloat(row[rateIdx])||0)*100)/100,Math.round(tax*100)/100]);
    }
    const sd=Array.from(dates).sort();
    return res.status(200).json({generated_at:new Date().toISOString(),rowCount:rows.length,rows,columnFormat:["date","category","dealer","region","model","qty","netRate","taxableValue"],availableDays:sd,availableMonths:[...new Set(sd.map(function(d){return d.slice(0,7);}))],availableYears:[...new Set(sd.map(function(d){return d.slice(0,4);}))]});
  }catch(e){return res.status(500).json({error:e.message,stack:e.stack});}
};
