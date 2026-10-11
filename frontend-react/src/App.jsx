import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Link, Navigate, Route, Routes, useLocation, useNavigate, useParams } from "react-router-dom";
import { api, getAuth, saveAuth } from "./api.js";

function Alert({ tone = "info", children }) {
  if (!children) return null;
  return <div className={"alert alert--" + tone} role={tone === "error" ? "alert" : "status"}>{children}</div>;
}
function Button({ kind = "primary", busy = false, className = "", children, ...props }) {
  return <button className={"button button--" + kind + " " + className} disabled={busy || props.disabled} {...props}>{busy ? "Please wait…" : children}</button>;
}
function Field({ label, ...props }) {
  return <label className="field"><span>{label}</span><input className="input" {...props}/></label>;
}
function SelectField({ label, children, ...props }) {
  return <label className="field"><span>{label}</span><select className="input" {...props}>{children}</select></label>;
}
function Card({ title, subtitle, value, children }) {
  return <section className="card">{(title || subtitle || value !== undefined) && <header className="card-head"><div>{title && <h3>{title}</h3>}{subtitle && <p className="muted">{subtitle}</p>}</div>{value !== undefined && <strong className="metric">{value}</strong>}</header>}{children}</section>;
}
function Loading() { return <div className="loading"><span className="spinner"/>Loading LEMS data…</div>; }
function Status({ value }) {
  const status = String(value || "unknown");
  return <span className={"status status--" + status.toLowerCase().replace(/[^a-z0-9]+/g, "-")}>{status.replace(/_/g, " ")}</span>;
}
function DataTable({ columns, rows, empty = "No records found." }) {
  if (!rows.length) return <div className="empty">{empty}</div>;
  return <div className="table-wrap"><table><thead><tr>{columns.map(c=><th key={c.key}>{c.label}</th>)}</tr></thead><tbody>{rows.map((r,i)=><tr key={r.transaction_id || r.equipment_id || r.complaint_id || r.user_id || i}>{columns.map(c=><td key={c.key}>{c.render ? c.render(r) : (r[c.key] ?? "—")}</td>)}</tr>)}</tbody></table></div>;
}
function PageTitle({ title, subtitle, actions }) {
  return <div className="page-title"><div><p className="eyebrow">LEMS WORKSPACE</p><h1>{title}</h1><p className="muted">{subtitle}</p></div><div className="actions">{actions}</div></div>;
}
function AuthScreen({ onLogin }) {
  const [mode,setMode]=useState("login"), [name,setName]=useState(""), [studentId,setStudentId]=useState(""), [email,setEmail]=useState(""), [password,setPassword]=useState(""), [confirm,setConfirm]=useState("");
  const [error,setError]=useState(""), [notice,setNotice]=useState(""), [busy,setBusy]=useState(false);
  const navigate=useNavigate();
  async function submit(e) {
    e.preventDefault();setError("");setNotice("");setBusy(true);
    try {
      if(mode==="signup") {
        if(password!==confirm) throw new Error("Passwords do not match.");
        const result=await api.signup({name,student_id:studentId,email,password});
        setNotice(result.message || "Account created. Please sign in.");setMode("login");setPassword("");setConfirm("");
      } else {
        const result=await api.login({student_id:studentId,password});
        const auth={token:result.token,user:result.user};saveAuth(auth);onLogin(result.user);navigate("/",{replace:true});
      }
    } catch(err){setError(err.message);} finally{setBusy(false);}
  }
  return <div className="auth-screen">
    <section className="auth-hero"><Link to="/login" className="brand brand-light"><span className="brand-mark">L</span><span>LEMS<small>LAB EQUIPMENT MANAGEMENT SYSTEM</small></span></Link>
      <div className="hero-copy"><p className="eyebrow light">SMARTER LAB OPERATIONS</p><h1>Every instrument.<br/>Accounted for.</h1><p>Track lab equipment availability, checkout activity and returns from one workspace designed for your lab.</p><div className="hero-detail"><b>01</b><span><strong>Live availability</strong><small>Know what is ready to use.</small></span></div><div className="hero-detail"><b>02</b><span><strong>Clear accountability</strong><small>Checkout and return history in one place.</small></span></div></div>
      <small className="hero-foot">ECE · LAB EQUIPMENT MANAGEMENT SYSTEM</small>
    </section>
    <section className="auth-panel"><div className="auth-box"><div className="auth-mobile-brand"><span className="brand-mark">L</span><b>LEMS</b></div><p className="eyebrow">{mode==="login"?"WELCOME BACK":"GET STARTED"}</p><h2>{mode==="login"?"Sign in to LEMS":"Create student account"}</h2><p className="muted">{mode==="login"?"Use your registered student ID and password.":"New registrations receive student access only."}</p>
      <Alert tone="error">{error}</Alert><Alert tone="success">{notice}</Alert><form className="stack" onSubmit={submit}>
      {mode==="signup"&&<><Field label="Full name" value={name} onChange={e=>setName(e.target.value)} autoComplete="name" required/><Field label="Email address" type="email" value={email} onChange={e=>setEmail(e.target.value)} autoComplete="email" required/></>}
      <Field label="Student ID" value={studentId} onChange={e=>setStudentId(e.target.value)} autoComplete="username" required/>
      <Field label="Password" type="password" value={password} onChange={e=>setPassword(e.target.value)} autoComplete={mode==="login"?"current-password":"new-password"} minLength={8} maxLength={128} required/>
      {mode==="signup"&&<Field label="Confirm password" type="password" value={confirm} onChange={e=>setConfirm(e.target.value)} minLength={8} maxLength={128} required/>}
      <Button type="submit" busy={busy} className="full">{mode==="login"?"Sign in →":"Create account →"}</Button></form>
      {mode==="login"&&<Link className="text-link forgot" to="/forgot-password">Forgot password?</Link>}
      <p className="switch">{mode==="login"?"New to LEMS?":"Already registered?"} <button onClick={()=>{setMode(mode==="login"?"signup":"login");setError("");setNotice("");}}>{mode==="login"?"Create an account":"Sign in"}</button></p>
      <p className="privacy">Access is checked by the server. Keep your sign-in details private.</p>
    </div></section>
  </div>;
}
function ResetPage({ forgot = false }) {
  const [email,setEmail]=useState(""),[password,setPassword]=useState(""),[confirm,setConfirm]=useState(""),[busy,setBusy]=useState(false),[error,setError]=useState(""),[notice,setNotice]=useState("");
  const navigate=useNavigate();const token=new URLSearchParams(window.location.search).get("token")||"";
  async function submit(e){e.preventDefault();setError("");setNotice("");setBusy(true);try{if(forgot){const r=await api.forgotPassword(email);setNotice(r.message||"If the account exists, reset instructions will be sent.");}else{if(password!==confirm)throw new Error("Passwords do not match.");const r=await api.resetPassword(token,password);setNotice(r.message||"Password updated.");setTimeout(()=>navigate("/login"),800);}}catch(err){setError(err.message);}finally{setBusy(false);}}
  return <div className="simple-auth"><Link to="/login" className="brand"><span className="brand-mark">L</span><span>LEMS<small>LAB EQUIPMENT MANAGEMENT SYSTEM</small></span></Link><Card title={forgot?"Reset your password":"Choose a new password"} subtitle={forgot?"Enter the email registered to your LEMS account.":"Reset links expire after one hour."}><Alert tone="error">{error||(!forgot&&!token?"Reset token is missing from this link.":"")}</Alert><Alert tone="success">{notice}</Alert><form className="stack" onSubmit={submit}>{forgot?<Field label="Email address" type="email" value={email} onChange={e=>setEmail(e.target.value)} required/>:token&&<><Field label="New password" type="password" minLength={8} maxLength={128} value={password} onChange={e=>setPassword(e.target.value)} required/><Field label="Confirm password" type="password" minLength={8} maxLength={128} value={confirm} onChange={e=>setConfirm(e.target.value)} required/></>}<Button busy={busy} type="submit" className="full" disabled={!forgot&&!token}>{forgot?"Request reset link":"Update password"}</Button></form><Link className="text-link" to="/login">← Back to sign in</Link></Card></div>;
}
function Shell({user,onLogout,children}) {
  const admin=String(user.role||"").toLowerCase()==="admin";
  return <div className="app-shell"><aside className="sidebar"><Link to="/" className="brand brand-light"><span className="brand-mark">L</span><span>LEMS<small>LAB EQUIPMENT SYSTEM</small></span></Link><small className="nav-label">WORKSPACE</small><nav><Link to="/">⌂ <span>Overview</span></Link><Link to="/equipment">▤ <span>Equipment</span></Link><Link to="/transactions">↺ <span>My transactions</span></Link>{admin&&<><small className="nav-label nav-spacer">ADMINISTRATION</small><Link to="/admin">▦ <span>Admin dashboard</span></Link><Link to="/admin/equipment/new">＋ <span>Add equipment</span></Link><Link to="/admin/users">♙ <span>Find a student</span></Link></>}</nav><div className="sidebar-profile"><div className="avatar">{String(user.name||"U").charAt(0).toUpperCase()}</div><span><b>{user.name||"LEMS user"}</b><small>{user.role||"student"}</small></span><button onClick={onLogout} title="Sign out">↪</button></div></aside><div className="main-col"><header className="topbar"><span className="mobile-brand">L · LEMS</span><span className="online-dot">● <small>Workspace</small></span><small className="top-user">{user.student_id||user.email}</small></header><main className="content">{children}</main><footer>LEMS · Lab Equipment Management System <span>Equipment accountability, made easier.</span></footer></div></div>;
}
function Overview({user}) {
 const [items,setItems]=useState([]),[active,setActive]=useState([]),[busy,setBusy]=useState(true),[error,setError]=useState(""),[notice,setNotice]=useState(""),[reportEquipmentId,setReportEquipmentId]=useState(""),[reportText,setReportText]=useState(""),[reportBusy,setReportBusy]=useState(false);
 const load=useCallback(async()=>{setBusy(true);setError("");try{const [e,t]=await Promise.all([api.equipment(),api.transactions(user.user_id)]);setItems(Array.isArray(e)?e:[]);setActive(Array.isArray(t)?t:[]);}catch(err){setError(err.message);}finally{setBusy(false);}},[user.user_id]);
 useEffect(()=>{load();},[load]);
 async function action(id,kind){setError("");setNotice("");try{if(kind==="checkout")await api.checkout(id);else await api.returnEquipment(id);setNotice(kind==="checkout"?"Checkout recorded successfully.":"Return recorded successfully.");await load();}catch(e){setError(e.message);}}
 async function reportIssue(e){e.preventDefault();setError("");setNotice("");setReportBusy(true);try{const result=await api.submitComplaint(Number(reportEquipmentId),reportText.trim());setNotice(result.message||"Maintenance request submitted.");setReportText("");setReportEquipmentId("");await load();}catch(err){setError(err.message);}finally{setReportBusy(false);}}
 const available=items.filter(i=>String(i.status).toUpperCase()==="AVAILABLE"&&Number(i.available_quantity??1)>0).length;
 const availableUnits=items.reduce((n,i)=>n+Number(i.available_quantity??(String(i.status).toUpperCase()==="AVAILABLE"?1:0)),0);
 const totalUnits=items.reduce((n,i)=>n+Number(i.total_quantity??1),0);
 return <><PageTitle title={"Welcome, "+(user.name||"there").split(" ")[0]} subtitle="Current status of your lab equipment workspace." actions={<Button kind="secondary" onClick={load}>↻ Refresh</Button>}/><Alert tone="error">{error}</Alert><Alert tone="success">{notice}</Alert>{busy?<Loading/>:<><div className="stats"><Card title="Equipment types" value={items.length} subtitle="Tracked in the lab"/><Card title="Available types" value={available} subtitle="Ready for checkout"/><Card title="Available units" value={availableUnits} subtitle={"Of "+totalUnits+" total units"}/><Card title="My active loans" value={active.length} subtitle="Items checked out"/></div><div className="section-title"><div><h2>Equipment availability</h2><p className="muted">Live data from the LEMS API.</p></div><Link to="/equipment" className="text-link">View all →</Link></div><Card><DataTable rows={items.slice(0,8)} empty="No equipment records are returned by the API." columns={[{key:"equipment_code",label:"Code"},{key:"name",label:"Equipment"},{key:"category",label:"Category"},{key:"status",label:"Status",render:r=><Status value={r.status}/>},{key:"availability",label:"Available / total",render:r=>(r.available_quantity??"—")+" / "+(r.total_quantity??"—")},{key:"action",label:"Action",render:r=>String(r.status).toUpperCase()==="AVAILABLE"&&Number(r.available_quantity??1)>0?<Button kind="secondary" className="small" onClick={()=>action(r.equipment_id,"checkout")}>Checkout</Button>:<span className="muted">Unavailable</span>}]}/></Card><div className="section-title"><div><h2>My active checkouts</h2><p className="muted">Return equipment when you have finished using it.</p></div><Link to="/transactions" className="text-link">View history →</Link></div><div className="loan-grid">{active.length?active.map(tx=><Card key={tx.transaction_id} title={tx.equipment_name||("Equipment #"+tx.equipment_id)} subtitle={tx.equipment_code||"Active checkout"}><p className="muted">Checked out {formatDate(tx.checkout_time)}</p><Button kind="secondary" onClick={()=>action(tx.equipment_id,"return")}>Return equipment</Button></Card>):<div className="empty">No active checkouts at the moment.</div>}</div></>}<Card title="Report an equipment issue" subtitle="Report damaged, missing, or malfunctioning equipment. The lab team can review it in the admin dashboard."><form className="form-grid" onSubmit={reportIssue}><SelectField label="Equipment" value={reportEquipmentId} onChange={e=>setReportEquipmentId(e.target.value)} required><option value="">Choose equipment…</option>{items.map(item=><option key={item.equipment_id} value={item.equipment_id}>{item.equipment_code} — {item.name}</option>)}</SelectField><label className="field"><span>Describe the issue</span><textarea className="input" rows="3" maxLength="2000" value={reportText} onChange={e=>setReportText(e.target.value)} placeholder="What happened? Include any visible damage or symptoms." required/></label><div className="form-actions"><Button type="submit" busy={reportBusy} disabled={!items.length||!reportEquipmentId||!reportText.trim()}>Submit issue report</Button></div></form></Card></>;
}
function EquipmentPage({user}) {
 const [items,setItems]=useState([]),[busy,setBusy]=useState(true),[error,setError]=useState(""),[search,setSearch]=useState(""),[notice,setNotice]=useState("");
 const load=useCallback(async()=>{setBusy(true);setError("");try{const r=await api.equipment();setItems(Array.isArray(r)?r:[]);}catch(e){setError(e.message);}finally{setBusy(false);}},[]);
 useEffect(()=>{load();},[load]);
 async function action(id,kind){setError("");setNotice("");try{if(kind==="checkout")await api.checkout(id);else await api.returnEquipment(id);setNotice(kind==="checkout"?"Checkout successful.":"Return successful.");await load();}catch(e){setError(e.message);}}
 const filtered=useMemo(()=>items.filter(i=>[i.equipment_code,i.name,i.category,i.status].some(v=>String(v||"").toLowerCase().includes(search.toLowerCase()))),[items,search]);
 const isAdmin=String(user.role||"").toLowerCase()==="admin";
 return <><PageTitle title="Equipment inventory" subtitle="Search instruments and see their current availability." actions={<Button kind="secondary" onClick={load}>↻ Refresh</Button>}/><Alert tone="error">{error}</Alert><Alert tone="success">{notice}</Alert><Card><Field label="Search inventory" placeholder="Code, equipment, category or status…" value={search} onChange={e=>setSearch(e.target.value)}/></Card>{busy?<Loading/>:<Card><DataTable rows={filtered} empty="No equipment matches your search." columns={[{key:"equipment_code",label:"Code"},{key:"name",label:"Equipment"},{key:"category",label:"Category"},{key:"status",label:"Status",render:r=><Status value={r.status}/>},{key:"stock",label:"Available / total",render:r=>(r.available_quantity??"—")+" / "+(r.total_quantity??"—")},{key:"action",label:"Action",render:r=>isAdmin?<Link className="text-link" to={"/admin/equipment/"+r.equipment_id+"/edit"}>Edit →</Link>:String(r.status).toUpperCase()==="AVAILABLE"&&Number(r.available_quantity??1)>0?<Button className="small" onClick={()=>action(r.equipment_id,"checkout")}>Checkout</Button>:<span className="muted">Unavailable</span>}]}/></Card>}</>;
}
function TransactionsPage({user}) {
 const [items,setItems]=useState([]),[busy,setBusy]=useState(true),[error,setError]=useState(""),[search,setSearch]=useState("");
 const load=useCallback(async()=>{setBusy(true);setError("");try{const r=await api.transactions(user.user_id,true);setItems(Array.isArray(r)?r:[]);}catch(e){setError(e.message);}finally{setBusy(false);}},[user.user_id]);
 useEffect(()=>{load();},[load]);
 const rows=useMemo(()=>items.filter(i=>[i.equipment_code,i.equipment_name,i.status].some(v=>String(v||"").toLowerCase().includes(search.toLowerCase()))),[items,search]);
 return <><PageTitle title="My transactions" subtitle="Review your equipment checkout and return history." actions={<Button kind="secondary" onClick={load}>↻ Refresh</Button>}/><Alert tone="error">{error}</Alert><Card><Field label="Search history" value={search} onChange={e=>setSearch(e.target.value)} placeholder="Equipment or status…"/></Card>{busy?<Loading/>:<Card><DataTable rows={rows} empty="No transaction history found." columns={[{key:"transaction_id",label:"ID"},{key:"equipment_code",label:"Code"},{key:"equipment_name",label:"Equipment"},{key:"checkout_time",label:"Checked out",render:r=>formatDate(r.checkout_time)},{key:"return_time",label:"Returned",render:r=>formatDate(r.return_time)},{key:"status",label:"Status",render:r=><Status value={r.status}/>}]}/></Card>}</>;
}
function EquipmentForm() {
 const {id}=useParams(),navigate=useNavigate(),editing=Boolean(id);
 const [form,setForm]=useState({equipment_code:"",name:"",category:"",rfid_tag:"",status:"AVAILABLE",calibration_limit:"500"}),[loading,setLoading]=useState(editing),[busy,setBusy]=useState(false),[error,setError]=useState("");
 useEffect(()=>{let alive=true;if(editing)api.equipment().then(rows=>{const item=rows.find(r=>String(r.equipment_id)===String(id));if(!item)throw new Error("Equipment record not found.");if(alive)setForm({equipment_code:item.equipment_code||"",name:item.name||"",category:item.category||"",rfid_tag:item.rfid_tag||"",status:item.status||"AVAILABLE",calibration_limit:String(item.calibration_limit??500)});}).catch(e=>setError(e.message)).finally(()=>setLoading(false));return()=>{alive=false;};},[id,editing]);
 const update=k=>e=>setForm(f=>({...f,[k]:e.target.value}));
 async function submit(e){e.preventDefault();setBusy(true);setError("");try{const data={...form,calibration_limit:Number(form.calibration_limit)};if(editing)await api.updateEquipment(id,data);else await api.addEquipment(data);navigate("/admin",{replace:true});}catch(err){setError(err.message);}finally{setBusy(false);}}
 if(loading)return <Loading/>;
 return <><PageTitle title={editing?"Edit equipment":"Add equipment"} subtitle="Maintain accurate identifiers, condition and calibration information."/><Alert tone="error">{error}</Alert><Card><form className="form-grid" onSubmit={submit}><Field label="Equipment code" value={form.equipment_code} onChange={update("equipment_code")} required/><Field label="Equipment name" value={form.name} onChange={update("name")} required/><Field label="Category" value={form.category} onChange={update("category")} required/><Field label="RFID tag" value={form.rfid_tag} onChange={update("rfid_tag")} required/><Field label="Calibration limit (hours)" type="number" min="1" value={form.calibration_limit} onChange={update("calibration_limit")} required/>{editing&&<SelectField label="Status" value={form.status} onChange={update("status")}><option>AVAILABLE</option><option>IN_USE</option><option>MAINTENANCE</option><option>LOST</option></SelectField>}<div className="form-actions"><Button type="button" kind="secondary" onClick={()=>navigate("/admin")}>Cancel</Button><Button type="submit" busy={busy}>{editing?"Save changes":"Add equipment"}</Button></div></form></Card></>;
}
function AdminPage() {
 const [equipment,setEquipment]=useState([]),[transactions,setTransactions]=useState([]),[complaints,setComplaints]=useState([]),[busy,setBusy]=useState(true),[error,setError]=useState(""),[notice,setNotice]=useState("");
 const load=useCallback(async()=>{setBusy(true);setError("");try{const [e,t,c]=await Promise.all([api.equipment(),api.allTransactions(),api.complaints()]);setEquipment(Array.isArray(e)?e:[]);setTransactions(Array.isArray(t)?t:[]);setComplaints(Array.isArray(c)?c:[]);}catch(err){setError(err.message);}finally{setBusy(false);}},[]);
 useEffect(()=>{load();},[load]);
 async function resolve(c){setError("");try{await api.resolveComplaint(c.complaint_id,{equipment_id:c.equipment_id,make_available:true});setNotice("Maintenance request resolved.");await load();}catch(e){setError(e.message);}}
 const active=transactions.filter(t=>String(t.status).toUpperCase()==="ACTIVE").length;
 return <><PageTitle title="Admin dashboard" subtitle="Manage the inventory, loans and maintenance requests." actions={<><Link className="button button--secondary" to="/admin/equipment/new">＋ Add equipment</Link><Button kind="secondary" onClick={load}>↻ Refresh</Button></>}/><Alert tone="error">{error}</Alert><Alert tone="success">{notice}</Alert>{busy?<Loading/>:<><div className="stats"><Card title="Equipment types" value={equipment.length}/><Card title="Available" value={equipment.filter(x=>String(x.status).toUpperCase()==="AVAILABLE").length}/><Card title="In use" value={equipment.filter(x=>String(x.status).toUpperCase()==="IN_USE").length}/><Card title="Active loans" value={active}/></div><div className="section-title"><h2>Equipment management</h2></div><Card><DataTable rows={equipment} empty="No equipment records found." columns={[{key:"equipment_code",label:"Code"},{key:"name",label:"Equipment"},{key:"category",label:"Category"},{key:"stock",label:"Available / total",render:r=>(r.available_quantity??"—")+" / "+(r.total_quantity??"—")},{key:"status",label:"Status",render:r=><Status value={r.status}/>},{key:"action",label:"Action",render:r=><Link className="text-link" to={"/admin/equipment/"+r.equipment_id+"/edit"}>Edit →</Link>}]}/></Card><div className="section-title"><h2>Open maintenance requests</h2></div><Card><DataTable rows={complaints.filter(c=>String(c.complaint_status||c.status).toUpperCase()!=="RESOLVED")} empty="No open requests." columns={[{key:"complaint_id",label:"Request"},{key:"equipment_code",label:"Equipment"},{key:"student_name",label:"Reported by"},{key:"issue_description",label:"Issue"},{key:"action",label:"Action",render:r=><Button kind="secondary" className="small" onClick={()=>resolve(r)}>Resolve</Button>}]}/></Card><div className="section-title"><h2>Recent transactions</h2></div><Card><DataTable rows={transactions.slice(0,12)} empty="No transactions found." columns={[{key:"transaction_id",label:"ID"},{key:"student_name",label:"Student"},{key:"equipment_code",label:"Code"},{key:"equipment_name",label:"Equipment"},{key:"checkout_time",label:"Checkout",render:r=>formatDate(r.checkout_time)},{key:"status",label:"Status",render:r=><Status value={r.status}/>} ]}/></Card><div className="section-title"><Link className="text-link" to="/admin/users">Find student and review history →</Link></div></>}</>;
}
function FindStudent() {
 const [studentId,setStudentId]=useState(""),[student,setStudent]=useState(null),[transactions,setTransactions]=useState([]),[error,setError]=useState(""),[busy,setBusy]=useState(false);
 async function submit(e){e.preventDefault();setBusy(true);setError("");setStudent(null);try{const r=await api.findStudent(studentId.trim());setStudent(r.student);setTransactions(r.transactions||[]);}catch(err){setError(err.message);}finally{setBusy(false);}}
 return <><PageTitle title="Find a student" subtitle="View an account and its transaction history."/><Card><form className="form-inline" onSubmit={submit}><Field label="Student ID" value={studentId} onChange={e=>setStudentId(e.target.value)} required/><Button type="submit" busy={busy}>Search</Button></form><Alert tone="error">{error}</Alert></Card>{student&&<><Card title={student.name} subtitle={student.email}><p>Student ID: <b>{student.student_id}</b> · Role: <b>{student.role}</b></p></Card><Card><DataTable rows={transactions} columns={[{key:"transaction_id",label:"ID"},{key:"equipment_code",label:"Code"},{key:"equipment_name",label:"Equipment"},{key:"checkout_time",label:"Checkout",render:r=>formatDate(r.checkout_time)},{key:"return_time",label:"Return",render:r=>formatDate(r.return_time)},{key:"status",label:"Status",render:r=><Status value={r.status}/>} ]}/></Card></>}</>;
}
function formatDate(value){if(!value)return "—";const d=new Date(typeof value==="string"?value.replace(" ","T"):value);return Number.isNaN(d.getTime())?"—":d.toLocaleString("en-IN",{dateStyle:"medium",timeStyle:"short",timeZone:"Asia/Kolkata"});}
function Guard({user,admin=false,children}){if(!user)return <Navigate to="/login" replace/>;if(admin&&String(user.role).toLowerCase()!=="admin")return <Navigate to="/" replace/>;return children;}
function App(){
 const [user,setUser]=useState(()=>getAuth()?.user||null);const location=useLocation(),navigate=useNavigate();
 useEffect(()=>{setUser(getAuth()?.user||null);},[location.pathname]);
 const logout=()=>{saveAuth(null);setUser(null);navigate("/login",{replace:true});};
 return <Routes>
 <Route path="/login" element={user?<Navigate to="/" replace/>:<AuthScreen onLogin={setUser}/>}/>
 <Route path="/forgot-password" element={<ResetPage forgot/>}/><Route path="/reset-password" element={<ResetPage/>}/>
 <Route path="/" element={<Guard user={user}><Shell user={user} onLogout={logout}><Overview user={user}/></Shell></Guard>}/>
 <Route path="/equipment" element={<Guard user={user}><Shell user={user} onLogout={logout}><EquipmentPage user={user}/></Shell></Guard>}/>
 <Route path="/transactions" element={<Guard user={user}><Shell user={user} onLogout={logout}><TransactionsPage user={user}/></Shell></Guard>}/>
 <Route path="/admin" element={<Guard user={user} admin><Shell user={user} onLogout={logout}><AdminPage/></Shell></Guard>}/>
 <Route path="/admin/equipment/new" element={<Guard user={user} admin><Shell user={user} onLogout={logout}><EquipmentForm/></Shell></Guard>}/>
 <Route path="/admin/equipment/:id/edit" element={<Guard user={user} admin><Shell user={user} onLogout={logout}><EquipmentForm/></Shell></Guard>}/>
 <Route path="/admin/users" element={<Guard user={user} admin><Shell user={user} onLogout={logout}><FindStudent/></Shell></Guard>}/>
 <Route path="*" element={<Navigate to={user?"/":"/login"} replace/>}/>
 </Routes>;
}
export default App;
