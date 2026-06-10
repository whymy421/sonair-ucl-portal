/**
 * SONAIR Request System v3
 * ═══════════════════════════════════════════════════════════════════
 * Aligned with the UoN sub-portal standard (v14).
 *
 * Priority order for storage:
 *   1. SONAIR Python server  — shared, cross-device, approve/reject
 *      (event request API server)
 *   2. GitHub Issues          — if configured, cross-device alternative
 *   3. localStorage           — last resort, same-device only
 *
 * ── SETUP ────────────────────────────────────────────────────────────
 *
 * Option A — Use the event request API endpoint
 *
 *   <script>window.SONAIR_API_BASE = 'http://EVENT_REQUEST_API:5055';</script>
 *   <script src="sonair_request_system.js"></script>
 *
 * Option B — Use GitHub Issues (if no shared server available)
 *
 *   <script>
 *     window.SONAIR_GITHUB_OWNER = 'your-github-username';
 *     window.SONAIR_GITHUB_REPO  = 'your-sonair-portal-repo';
 *     window.SONAIR_GITHUB_TOKEN = 'ghp_xxxxxxxxxxxxxxxxxxxx';
 *   </script>
 *   <script src="sonair_request_system.js"></script>
 *
 * Option C — localStorage only (same device, demo/testing only)
 * No config needed. Automatic fallback when A and B are unavailable.
 *
 * ── ADD BUTTONS AND INBOX ────────────────────────────────────────────
 *
 *   <button onclick="SONAIR_REQUESTS.openForm('visit')">Apply to Visit</button>
 *   <button onclick="SONAIR_REQUESTS.openForm('collab')">Apply to Collaborate</button>
 *
 *   <div id="my-inbox"></div>
 *   <script>SONAIR_REQUESTS.renderInbox('my-inbox');</script>
 */

(function () {
  'use strict';

  const API_BASE = window.SONAIR_API_BASE || 'http://127.0.0.1:5055';
  const GH_OWNER = window.SONAIR_GITHUB_OWNER || null;
  const GH_REPO  = window.SONAIR_GITHUB_REPO  || null;
  const GH_TOKEN = window.SONAIR_GITHUB_TOKEN  || null;
  const USE_GITHUB = !!(GH_OWNER && GH_REPO && GH_TOKEN);

  let _nodeId      = window.SONAIR_NODE_ID || null;
  let _portalTitle = document.title || 'SONAIR Sub-Portal';
  let _modalEl     = null;
  let _inboxTargets = [];
  let _backendMode  = 'detecting';

  fetch('federation.json', { cache: 'no-store' })
    .then(r => r.ok ? r.json() : null)
    .then(fed => {
      if (!fed) return;
      if (!_nodeId) _nodeId = fed.node?.id || 'unknown';
      if (fed.co_creation_card?.title) _portalTitle = fed.co_creation_card.title;
      _inboxTargets.forEach(id => _renderInboxInto(id));
    }).catch(() => {});

  async function detectBackend() {
    if (_backendMode !== 'detecting') return _backendMode;
    try {
      const r = await fetch(API_BASE + '/api/health', { cache: 'no-store' });
      if (r.ok) { _backendMode = 'server'; return 'server'; }
    } catch (_) {}
    if (USE_GITHUB) { _backendMode = 'github'; return 'github'; }
    _backendMode = 'local'; return 'local';
  }

  // ── Backend A: Python server ──────────────────────────────────────
  async function serverSubmit(payload) {
    const r = await fetch(API_BASE + '/api/applications', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    if (!r.ok) throw new Error('Server returned ' + r.status);
    return await r.json();
  }
  async function serverLoad() {
    const r = await fetch(`${API_BASE}/api/applications?subportal_id=${encodeURIComponent(_nodeId||'unknown')}`, { cache: 'no-store' });
    if (!r.ok) throw new Error('Server returned ' + r.status);
    return (await r.json()).applications || [];
  }
  async function serverPatch(id, status) {
    const r = await fetch(`${API_BASE}/api/applications/${encodeURIComponent(id)}/status`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status }) });
    if (!r.ok) throw new Error('Server returned ' + r.status);
    return await r.json();
  }

  // ── Backend B: GitHub Issues ──────────────────────────────────────
  const L_REQ='sonair-request', L_VISIT='visit', L_COLLAB='collaboration', L_APP='approved', L_REJ='rejected';
  const ghH = () => ({ 'Authorization': `Bearer ${GH_TOKEN}`, 'Accept': 'application/vnd.github+json', 'Content-Type': 'application/json', 'X-GitHub-Api-Version': '2022-11-28' });
  async function ghEnsureLabels() {
    for (const l of [{name:L_REQ,color:'1d9e75'},{name:L_VISIT,color:'0075ca'},{name:L_COLLAB,color:'7057ff'},{name:L_APP,color:'0e8a16'},{name:L_REJ,color:'e4e669'}])
      await fetch(`https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/labels`,{method:'POST',headers:ghH(),body:JSON.stringify(l)}).catch(()=>{});
  }
  async function ghSubmit(rec) {
    await ghEnsureLabels();
    const body=[`**Name:** ${rec.full_name}`,`**Institution:** ${rec.institution}`,`**Email:** ${rec.email}`,`**Role:** ${rec.role||'—'}`,'','### Purpose',rec.purpose||'*(not provided)*','','---',`*SONAIR Request · ${new Date(rec.created_at).toUTCString()} · Node: ${rec.subportal_id}*`].join('\n');
    const r=await fetch(`https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/issues`,{method:'POST',headers:ghH(),body:JSON.stringify({title:`[SONAIR ${rec.type.toUpperCase()}] ${rec.full_name} — ${rec.institution}`,body,labels:[L_REQ,rec.type==='visit'?L_VISIT:L_COLLAB]})});
    if(!r.ok) throw new Error('GitHub API '+r.status); return await r.json();
  }
  function ghParse(issue) {
    const ln=issue.labels.map(l=>l.name),body=issue.body||'',get=f=>{const m=body.match(new RegExp(`\\*\\*${f}:\\*\\*\\s*(.+)`));return m?m[1].trim():'';},purpM=body.match(/### Purpose\n([\s\S]*?)\n---/);
    return {id:String(issue.number),issue_number:issue.number,github_url:issue.html_url,type:ln.includes(L_COLLAB)?'collaboration':'visit',
      status:ln.includes(L_APP)?'approved':ln.includes(L_REJ)?'rejected':'pending',
      full_name:get('Name'),institution:get('Institution'),email:get('Email'),role:get('Role')==='—'?'':get('Role'),
      purpose:purpM?purpM[1].trim().replace('*(not provided)*',''):'',created_at:issue.created_at,updated_at:issue.updated_at};
  }
  async function ghLoad() {
    const [a,b]=await Promise.all([fetch(`https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/issues?labels=${L_REQ}&state=open&per_page=50`,{headers:ghH(),cache:'no-store'}),fetch(`https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/issues?labels=${L_REQ}&state=closed&per_page=20`,{headers:ghH(),cache:'no-store'})]);
    if(!a.ok) throw new Error('GitHub API '+a.status);
    return [...(await a.json()),...(b.ok?await b.json():[])].map(ghParse);
  }
  async function ghPatch(issueNumber, status) {
    const add=status==='approved'?L_APP:status==='rejected'?L_REJ:null,rm=status==='approved'?L_REJ:status==='rejected'?L_APP:null;
    if(add) await fetch(`https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/issues/${issueNumber}/labels`,{method:'POST',headers:ghH(),body:JSON.stringify({labels:[add]})});
    if(rm)  await fetch(`https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/issues/${issueNumber}/labels/${rm}`,{method:'DELETE',headers:ghH()}).catch(()=>{});
    await fetch(`https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/issues/${issueNumber}`,{method:'PATCH',headers:ghH(),body:JSON.stringify({state:status==='pending'?'open':'closed'})});
  }

  // ── Backend C: localStorage ───────────────────────────────────────
  const lsKey=()=>'sonair_requests_'+(_nodeId||'unknown');
  const lsLoad=()=>{try{return JSON.parse(localStorage.getItem(lsKey())||'[]');}catch(_){return[];}};
  const lsSave=r=>{try{localStorage.setItem(lsKey(),JSON.stringify(r));}catch(_){}};
  const lsInsert=rec=>{const r=lsLoad();r.unshift(rec);lsSave(r);return rec;};
  const lsUpdate=(id,status)=>{const r=lsLoad(),rec=r.find(x=>x.id===id);if(rec){rec.status=status;rec.updated_at=new Date().toISOString();}lsSave(r);return rec;};
  const lsDelete=id=>lsSave(lsLoad().filter(r=>r.id!==id));
  const newId=()=>'req-'+Date.now()+'-'+Math.random().toString(36).slice(2,6);

  // ── Unified operations ────────────────────────────────────────────
  async function submit(record) {
    const mode = await detectBackend();
    if (mode === 'server') {
      const res = await serverSubmit({...record,status:'pending',created_at:new Date().toISOString()});
      return {backendId:res.application?.id,url:null};
    } else if (mode === 'github') {
      const issue = await ghSubmit(record);
      return {backendId:String(issue.number),url:issue.html_url};
    } else {
      lsInsert(record);
      const fb=JSON.parse(localStorage.getItem('sonair_applications_fallback')||'[]');
      fb.unshift(record);localStorage.setItem('sonair_applications_fallback',JSON.stringify(fb));
      window.dispatchEvent(new CustomEvent('sonair-application-created',{detail:record}));
      return {backendId:record.id,url:null};
    }
  }

  async function loadRequests() {
    const mode = await detectBackend();
    if (mode === 'server')  return await serverLoad();
    if (mode === 'github')  return await ghLoad();
    return lsLoad();
  }

  async function patchStatus(id, issueNumber, status) {
    const mode = await detectBackend();
    if (mode === 'server')  return await serverPatch(id, status);
    if (mode === 'github')  return await ghPatch(issueNumber||Number(id), status);
    return lsUpdate(id, status);
  }

  // ── Modal ─────────────────────────────────────────────────────────
  function _ensureModal() {
    if (_modalEl) return _modalEl;
    const el = document.createElement('div');
    el.id = 'sonair-request-modal';
    el.innerHTML = `<style>
#sonair-request-modal{display:none;position:fixed;inset:0;z-index:9999;background:rgba(2,8,14,.88);backdrop-filter:blur(4px);align-items:center;justify-content:center}
#sonair-request-modal.open{display:flex}
#srm-box{width:640px;max-width:96vw;max-height:92vh;overflow-y:auto;background:#0b131a;border:1px solid rgba(25,230,194,.35);border-radius:12px;padding:20px 24px;font-family:system-ui,-apple-system,sans-serif;color:#c8d8e8;box-sizing:border-box;position:relative}
#srm-box *{box-sizing:border-box}
#srm-title{font-size:15px;font-weight:700;color:#e8f0f8;margin:0 0 2px}
#srm-subtitle{font-size:11px;color:rgba(100,160,180,.8);margin:0 0 14px;line-height:1.5}
#srm-close{position:absolute;top:14px;right:16px;background:none;border:none;color:#19e6c2;font-size:20px;cursor:pointer}
#srm-badge{display:inline-flex;align-items:center;gap:5px;font-size:9px;font-family:monospace;padding:2px 8px;border-radius:3px;background:rgba(25,230,194,.07);border:1px solid rgba(25,230,194,.18);color:rgba(100,200,180,.7);margin-bottom:12px}
#srm-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px}
@media(max-width:480px){#srm-grid{grid-template-columns:1fr}}
.srm-f label{display:block;font-size:10px;color:rgba(100,160,180,.8);margin-bottom:3px;text-transform:uppercase;letter-spacing:.04em}
.srm-f input,.srm-f textarea{width:100%;background:#060c12;border:1px solid rgba(25,230,194,.2);border-radius:5px;padding:7px 10px;color:#c8d8e8;font-size:12px;font-family:inherit;outline:none;transition:border-color .15s}
.srm-f input:focus,.srm-f textarea:focus{border-color:rgba(25,230,194,.6)}
.srm-f textarea{resize:vertical;min-height:72px}
#srm-footer{display:flex;align-items:center;justify-content:space-between;padding-top:12px;border-top:1px solid rgba(25,230,194,.12);gap:8px}
#srm-fn{font-size:10px;color:rgba(100,150,170,.6);flex:1}
.srm-btn{padding:6px 16px;border-radius:5px;font-size:12px;font-weight:600;cursor:pointer;border:1px solid rgba(25,230,194,.35);font-family:inherit;transition:all .15s}
.srm-p{background:rgba(25,230,194,.15);color:#19e6c2}.srm-p:hover{background:rgba(25,230,194,.25)}.srm-p:disabled{opacity:.5;cursor:not-allowed}
.srm-s{background:none;color:rgba(100,160,180,.7);border-color:rgba(100,160,180,.2)}.srm-s:hover{color:#c8d8e8}
#srm-ok{display:none;padding:16px;background:rgba(25,230,194,.06);border:1px solid rgba(25,230,194,.25);border-radius:7px;text-align:center}
#srm-ok-t{font-size:14px;font-weight:700;color:#19e6c2;margin-bottom:6px}
#srm-ok-m{font-size:11px;color:rgba(150,190,200,.8);line-height:1.6;margin-bottom:4px}
#srm-ok-id{font-size:9px;font-family:monospace;color:rgba(100,150,160,.6)}
#srm-ok-lnk{display:none;margin-top:8px;padding:4px 12px;border-radius:4px;border:1px solid rgba(25,230,194,.3);background:rgba(25,230,194,.08);color:#19e6c2;font-size:10px;text-decoration:none}
#srm-again{display:inline-block;margin:8px 0 0 6px;padding:4px 12px;border-radius:4px;border:1px solid rgba(100,150,160,.2);color:rgba(100,150,160,.7);font-size:10px;cursor:pointer}
#srm-err{font-size:11px;color:#f87171;margin-top:6px;display:none}
</style>
<div id="srm-box">
  <button id="srm-close">✕</button>
  <div id="srm-badge">⬤ detecting backend…</div>
  <div id="srm-title">Apply to Visit</div>
  <div id="srm-subtitle"></div>
  <div id="srm-fa">
    <div id="srm-grid">
      <div class="srm-f"><label>Full name *</label><input id="srm-n" type="text" placeholder="Your name" autocomplete="name"/></div>
      <div class="srm-f"><label>Institution *</label><input id="srm-i" type="text" placeholder="e.g. University of Sheffield" autocomplete="organization"/></div>
      <div class="srm-f"><label>Email *</label><input id="srm-e" type="email" placeholder="name@institution.ac.uk" autocomplete="email"/></div>
      <div class="srm-f"><label>Role</label><input id="srm-r" type="text" placeholder="PhD / RA / PI / Engineer / Partner"/></div>
    </div>
    <div class="srm-f" style="margin-bottom:14px"><label>Purpose</label>
      <textarea id="srm-p" placeholder="Briefly describe why you want to visit or collaborate, what you can contribute, and any preferred dates."></textarea></div>
    <div id="srm-err"></div>
    <div id="srm-footer">
      <div id="srm-fn"></div>
      <div style="display:flex;gap:8px">
        <button class="srm-btn srm-s" id="srm-cancel">Cancel</button>
        <button class="srm-btn srm-p" id="srm-submit">Submit request</button>
      </div>
    </div>
  </div>
  <div id="srm-ok">
    <div id="srm-ok-t">✓ Request submitted</div>
    <div id="srm-ok-m"></div>
    <div id="srm-ok-id"></div>
    <a id="srm-ok-lnk" href="#" target="_blank" rel="noopener">View on GitHub →</a>
    <span id="srm-again">Submit another</span>
  </div>
</div>`;
    document.body.appendChild(el);
    _modalEl = el;
    el.querySelector('#srm-close').onclick  = _close;
    el.querySelector('#srm-cancel').onclick = _close;
    el.addEventListener('click', e => { if (e.target === el) _close(); });
    el.querySelector('#srm-submit').onclick = _handleSubmit;
    el.querySelector('#srm-again').onclick  = _reset;
    detectBackend().then(mode => {
      const badge = el.querySelector('#srm-badge');
      const note  = el.querySelector('#srm-fn');
      const map   = {server:['⬤ SONAIR server connected','rgba(63,185,80,.7)','Saved to the shared SONAIR database. The campus team will review and respond.'],
                     github:['⬤ GitHub Issues','rgba(122,140,255,.7)','Creates a GitHub Issue visible to the campus team immediately.'],
                     local: ['⚠ local only','rgba(200,100,50,.7)','⚠ Saved locally only — campus team must be on this device to see it. Check the event request API endpoint.']};
      if (badge && map[mode]) { badge.textContent = map[mode][0]; badge.style.color = map[mode][1]; }
      if (note  && map[mode]) note.textContent = map[mode][2];
    });
    return el;
  }

  function _close() { if (_modalEl) { _modalEl.classList.remove('open'); _reset(); } }
  function _reset() {
    if (!_modalEl) return;
    ['#srm-n','#srm-i','#srm-e','#srm-r','#srm-p'].forEach(s => { const e=_modalEl.querySelector(s);if(e)e.value=''; });
    _modalEl.querySelector('#srm-fa').style.display = '';
    _modalEl.querySelector('#srm-ok').style.display = 'none';
    _modalEl.querySelector('#srm-err').style.display = 'none';
    const btn = _modalEl.querySelector('#srm-submit'); btn.disabled=false; btn.textContent='Submit request';
  }

  let _mode = 'visit';

  async function _handleSubmit() {
    const el=_modalEl, name=el.querySelector('#srm-n').value.trim(), inst=el.querySelector('#srm-i').value.trim(),
          email=el.querySelector('#srm-e').value.trim(), role=el.querySelector('#srm-r').value.trim(),
          purp=el.querySelector('#srm-p').value.trim(), errEl=el.querySelector('#srm-err'), btn=el.querySelector('#srm-submit');
    errEl.style.display='none';
    if(!name||!inst||!email){errEl.textContent='✗ Please fill in name, institution, and email.';errEl.style.display='block';return;}
    btn.disabled=true; btn.textContent='Submitting…';
    const now=new Date().toISOString();
    const record={id:newId(),type:_mode==='visit'?'visit':'collaboration',status:'pending',
      full_name:name,institution:inst,email,role,purpose:purp,
      project_id:(_nodeId||'unknown')+'-federated-card',project_title:_portalTitle,
      subportal_id:_nodeId||'unknown',created_at:now,updated_at:now};
    try {
      const res=await submit(record);
      if(res.backendId) record.id=res.backendId;
      el.querySelector('#srm-fa').style.display='none';
      el.querySelector('#srm-ok-m').textContent=`Your ${_mode} request has been submitted. The campus team will contact you at ${email}.`;
      el.querySelector('#srm-ok-id').textContent='Request ID: '+record.id;
      const lnk=el.querySelector('#srm-ok-lnk');
      if(res.url){lnk.href=res.url;lnk.style.display='inline';}
      el.querySelector('#srm-ok').style.display='block';
      _inboxTargets.forEach(id=>_renderInboxInto(id));
    } catch(err) {
      errEl.textContent='✗ '+(err.message||'Submission failed. Please try again.');
      errEl.style.display='block'; btn.disabled=false; btn.textContent='Submit request';
    }
  }

  function openForm(mode) {
    _mode=mode||'visit';
    const el=_ensureModal(); _reset();
    el.querySelector('#srm-title').textContent   = mode==='visit'?'Apply to Visit':'Apply to Collaborate';
    el.querySelector('#srm-subtitle').textContent= mode==='visit'
      ?`Request a guided visit or demo session at ${_portalTitle}.`
      :`Express your interest in collaborating with ${_portalTitle} on datasets, methods, or joint evaluation.`;
    el.classList.add('open');
    setTimeout(()=>el.querySelector('#srm-n')?.focus(),50);
  }

  // ── Inbox ─────────────────────────────────────────────────────────
  const esc=s=>String(s||'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

  async function _renderInboxInto(containerId) {
    const container=document.getElementById(containerId); if(!container) return;
    const mode=await detectBackend();
    let records=[],err=null;
    try{records=await loadRequests();}catch(e){err=e.message;}
    const pending=records.filter(r=>r.status==='pending').length;
    const modeNote={
      server:`<span style="font-size:9px;font-family:monospace;color:rgba(63,185,80,.6);">⬤ SONAIR server · ${API_BASE}</span>`,
      github:`<span style="font-size:9px;font-family:monospace;color:rgba(122,140,255,.6);">⬤ GitHub Issues · ${GH_OWNER}/${GH_REPO}</span>`,
      local: `<span style="font-size:9px;color:rgba(200,100,50,.7);">⚠ localStorage only — visible on this device only. Check the event request API endpoint (SONAIR_API_BASE).</span>`,
    }[mode]||'';
    const reqHtml=err
      ?`<div style="font-size:11px;color:#f87171;padding:8px;">Error: ${esc(err)}</div>`
      :!records.length
        ?`<div style="font-size:11px;color:rgba(100,150,160,.6);font-style:italic;padding:12px;text-align:center;">No requests yet.</div>`
        :records.map(r=>{
          const sc=r.status==='approved'?'#3fb950':r.status==='rejected'?'#f87171':'#d29922';
          const sb=r.status==='approved'?'rgba(46,160,67,.15)':r.status==='rejected'?'rgba(229,72,77,.12)':'rgba(210,153,34,.12)';
          const ip=r.status==='pending', ref=r.issue_number||r.id;
          return `<div style="border:1px solid rgba(25,230,194,.15);border-radius:6px;padding:9px 11px;margin-bottom:7px;background:#07101a;font-family:system-ui,-apple-system,sans-serif;">
            <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:8px;margin-bottom:4px;">
              <div>
                <div style="font-size:12px;font-weight:700;color:#e8f0f8;">${esc(r.full_name)}</div>
                <div style="font-size:10px;color:rgba(100,150,160,.7);font-family:monospace;margin-top:1px;">${esc(r.institution)} · ${esc(r.role||'role not specified')}<br>${esc(r.email)}</div>
              </div>
              <div style="display:flex;align-items:center;gap:5px;flex-shrink:0;">
                <span style="padding:2px 7px;border-radius:3px;font-size:9px;font-weight:700;font-family:monospace;background:${sb};color:${sc};border:1px solid ${sc}44;">${esc(r.status.toUpperCase())}</span>
                ${r.github_url?`<a href="${esc(r.github_url)}" target="_blank" rel="noopener" style="font-size:9px;color:rgba(100,180,160,.5);text-decoration:none;">#${esc(String(r.id))}</a>`:''}
              </div>
            </div>
            <div style="font-size:10px;color:rgba(100,150,160,.6);margin-bottom:5px;">
              <span style="font-size:9px;font-family:monospace;padding:1px 5px;border-radius:2px;background:rgba(25,230,194,.08);color:#19e6c2;margin-right:4px;">${esc((r.type||'').toUpperCase())}</span>
              ${esc(r.created_at?r.created_at.slice(0,16).replace('T',' '):'')}
            </div>
            ${r.purpose?`<div style="font-size:10px;color:#c8d8e8;line-height:1.5;margin:5px 0 7px;padding:5px 8px;border-left:2px solid rgba(25,230,194,.25);background:rgba(25,230,194,.03);border-radius:2px;">${esc(r.purpose)}</div>`:''}
            <div style="display:flex;gap:6px;">
              <button onclick="SONAIR_REQUESTS.updateRequest('${esc(String(r.id))}','${esc(String(ref))}','approved','${esc(containerId)}')" ${!ip?'disabled':''} style="padding:3px 10px;border-radius:4px;font-size:10px;font-weight:700;cursor:${ip?'pointer':'not-allowed'};opacity:${ip?1:.4};border:1px solid rgba(46,160,67,.4);color:#3fb950;background:none;font-family:inherit;">Approve</button>
              <button onclick="SONAIR_REQUESTS.updateRequest('${esc(String(r.id))}','${esc(String(ref))}','rejected','${esc(containerId)}')" ${!ip?'disabled':''} style="padding:3px 10px;border-radius:4px;font-size:10px;font-weight:700;cursor:${ip?'pointer':'not-allowed'};opacity:${ip?1:.4};border:1px solid rgba(229,72,77,.35);color:#f87171;background:none;font-family:inherit;">Reject</button>
              ${mode==='local'?`<button onclick="SONAIR_REQUESTS.deleteRequest('${esc(String(r.id))}','${esc(containerId)}')" style="padding:3px 10px;border-radius:4px;font-size:10px;cursor:pointer;border:1px solid rgba(100,100,100,.2);color:rgba(150,150,150,.6);background:none;font-family:inherit;">Delete</button>`:''}
            </div>
          </div>`;
        }).join('');
    container.innerHTML=`<div style="font-family:system-ui,-apple-system,sans-serif;color:#c8d8e8;">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">
        <span style="font-size:12px;font-weight:700;color:#e8f0f8;">Requests Inbox</span>
        ${pending>0?`<span style="padding:2px 7px;border-radius:10px;font-size:9px;font-weight:700;background:rgba(210,153,34,.18);color:#d29922;border:1px solid rgba(210,153,34,.4);">${pending} pending</span>`:''}
        <button onclick="SONAIR_REQUESTS.renderInbox('${esc(containerId)}')" style="margin-left:auto;background:none;border:none;color:rgba(100,160,180,.5);cursor:pointer;font-size:10px;font-family:inherit;">↻ Refresh</button>
      </div>
      <div style="margin-bottom:8px;">${modeNote}</div>${reqHtml}</div>`;
  }

  function renderInbox(id) { if(!_inboxTargets.includes(id)) _inboxTargets.push(id); _renderInboxInto(id); }

  async function updateRequest(id,ref,status,inboxId) {
    const btn=event?.target; if(btn){btn.disabled=true;btn.textContent='…';}
    try {
      await patchStatus(id,ref,status);
      if(inboxId) await _renderInboxInto(inboxId); else _inboxTargets.forEach(cid=>_renderInboxInto(cid));
    } catch(err) {
      alert('Update failed: '+err.message);
      if(btn){btn.disabled=false;btn.textContent=status==='approved'?'Approve':'Reject';}
    }
  }
  function deleteRequest(id,inboxId) { lsDelete(id); if(inboxId) _renderInboxInto(inboxId); else _inboxTargets.forEach(cid=>_renderInboxInto(cid)); }

  // 5-second auto-refresh + same-page event listener (matches UoN v14)
  setInterval(()=>_inboxTargets.forEach(id=>_renderInboxInto(id)),5000);
  window.addEventListener('sonair-application-created',()=>_inboxTargets.forEach(id=>_renderInboxInto(id)));

  window.SONAIR_REQUESTS = { openForm, renderInbox, updateRequest, deleteRequest,
    getAll:()=>loadRequests(),
    exportCSV:()=>{const r=lsLoad(),h=['id','type','status','full_name','institution','email','role','purpose','created_at'];return[h.join(','),...r.map(x=>h.map(k=>JSON.stringify(x[k]||'')).join(','))].join('\n');}};
})();
