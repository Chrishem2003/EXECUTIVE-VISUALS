const NAV_KEY="ev-navigation-collapsed";
const $=<T extends HTMLElement>(selector:string)=>document.querySelector<T>(selector);
let open=false;
function destinations(){return Array.from(document.querySelectorAll<HTMLButtonElement>("#nav [data-tab]")).map(button=>({id:button.dataset.tab||"",label:button.innerText.trim(),group:button.closest(".nav-group")?.querySelector("small")?.textContent||"Workspace",button}));}
function drawResults(query:string){
 const q=query.trim().toLowerCase();
 const items=destinations().filter(item=>!q||(item.label+" "+item.group).toLowerCase().includes(q));
 const root=$<HTMLElement>("#ev-nav-results");
 if(!root)return;
 root.innerHTML=items.length?items.map(item=>'<button class="nav-command-item" type="button" data-nav-destination="'+item.id+'"><span>'+item.label.slice(0,1)+'</span><b>'+item.label+'</b><small>'+item.group+'</small><kbd>↵</kbd></button>').join(""):'<p class="nav-command-empty">No destinations found. Try another search.</p>';
}
function closePalette(){open=false;const palette=$<HTMLElement>("#ev-nav-palette");if(palette)palette.hidden=true;}
function openPalette(){
 const palette=$<HTMLElement>("#ev-nav-palette"),input=$<HTMLInputElement>("#ev-nav-search");
 if(!palette||!input)return;
 open=true;palette.hidden=false;input.value="";drawResults("");input.focus();
}
export function initNavigation(){
 const app=$<HTMLElement>("#app"),sidebar=$<HTMLElement>(".sidebar"),brand=$<HTMLElement>(".brand"),topbar=$<HTMLElement>(".topbar");
 if(!app||!sidebar||!brand||!topbar)return;
 const brandRow=document.createElement("div");brandRow.className="sidebar-brand-row";brand.parentElement?.insertBefore(brandRow,brand);brandRow.append(brand);
 const collapse=document.createElement("button");collapse.className="nav-collapse";collapse.type="button";collapse.textContent="‹";collapse.title="Collapse navigation";collapse.setAttribute("aria-label","Collapse navigation");brandRow.append(collapse);
 const mobile=document.createElement("button");mobile.className="mobile-nav-open";mobile.type="button";mobile.textContent="☰";mobile.setAttribute("aria-label","Open navigation");topbar.prepend(mobile);
 const actions=topbar.querySelector(":scope > div:last-child")||topbar;actions.classList.add("topbar-actions");const crumb=topbar.querySelector(":scope > div:first-of-type");crumb?.classList.add("topbar-crumb");
 const search=document.createElement("button");search.className="command-trigger";search.type="button";search.title="Search or jump to a workspace (Ctrl K)";search.innerHTML='<span>⌕</span> Search or jump to… <kbd>Ctrl K</kbd>';actions.prepend(search);
 const close=document.createElement("button");close.className="mobile-nav-close";close.type="button";close.textContent="×";close.setAttribute("aria-label","Close navigation");sidebar.insertBefore(close,$("#nav"));
 const scrim=document.createElement("button");scrim.className="mobile-scrim";scrim.type="button";scrim.setAttribute("aria-label","Close navigation");sidebar.insertAdjacentElement("afterend",scrim);
 const palette=document.createElement("div");palette.id="ev-nav-palette";palette.className="nav-command-overlay";palette.hidden=true;palette.innerHTML='<button class="nav-command-backdrop" data-nav-close aria-label="Close search"></button><section class="nav-command-dialog" role="dialog" aria-modal="true" aria-label="Search and navigate"><div class="nav-command-input"><span>⌕</span><input id="ev-nav-search" type="search" placeholder="Search any workspace…" autocomplete="off"><kbd>ESC</kbd></div><div class="nav-command-hint">JUMP TO A WORKSPACE · CTRL K</div><div id="ev-nav-results" class="nav-command-results"></div></section>';document.body.append(palette);
 const setCollapsed=(value:boolean)=>{app.classList.toggle("nav-collapsed",value);collapse.textContent=value?"›":"‹";collapse.title=value?"Expand navigation":"Collapse navigation";collapse.setAttribute("aria-label",collapse.title);localStorage.setItem(NAV_KEY,value?"1":"0");};
 setCollapsed(localStorage.getItem(NAV_KEY)==="1");
 const setMobile=(value:boolean)=>{app.classList.toggle("nav-mobile-open",value);};
 collapse.addEventListener("click",()=>setCollapsed(!app.classList.contains("nav-collapsed")));
 mobile.addEventListener("click",()=>setMobile(true));close.addEventListener("click",()=>setMobile(false));scrim.addEventListener("click",()=>setMobile(false));
 search.addEventListener("click",openPalette);
 palette.addEventListener("click",event=>{const target=event.target as HTMLElement;if(target.closest("[data-nav-close]")){closePalette();return;}const item=target.closest<HTMLElement>("[data-nav-destination]");if(item){const destination=destinations().find(entry=>entry.id===item.dataset.navDestination);destination?.button.click();closePalette();}});
 palette.addEventListener("input",event=>{const target=event.target as HTMLInputElement;if(target.id==="ev-nav-search")drawResults(target.value);});
 document.addEventListener("click",event=>{const target=event.target as HTMLElement;if(target.closest("#nav [data-tab]"))setMobile(false);});
 document.addEventListener("keydown",event=>{
  if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==="k"){event.preventDefault();openPalette();return;}
  if(event.key==="Escape"){if(open){closePalette();return;}setMobile(false);}
  if(event.key==="/"&&!/INPUT|TEXTAREA|SELECT/.test((event.target as HTMLElement)?.tagName||"")){event.preventDefault();openPalette();}
 });
 window.addEventListener("resize",()=>{if(window.innerWidth>760)setMobile(false);});
}
