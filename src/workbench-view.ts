import { badgeRows } from './hash-badge.ts';
import { type WorkbenchRoute } from './document.ts';
import { parseAddress } from '../vendor/blob-store/src/proof.ts';

const el=<T extends HTMLElement>(id:string)=>document.getElementById(id) as T;
type Kind=WorkbenchRoute['kind'];

/** Host-owned layout only. Existing editor nodes survive hide/show and child restart. */
export class WorkbenchView {
  kind:Kind='home';
  private mounted=false;
  private address:string|null=null;
  private readonly panel=el('overlay-panel');
  private readonly toggle=el<HTMLButtonElement>('overlay-toggle');
  onExpand=()=>{};

  constructor() {
    this.toggle.onclick=()=>this.expand(this.panel.hidden);
    el('overlay').addEventListener('keydown',event=>{
      // The textarea already uses Escape, then Tab to leave indentation mode.
      if(event.key==='Escape'&&event.target!==el('source')){event.preventDefault();this.expand(false);}
    });
  }
  setKind(kind:Kind):void {
    this.kind=kind;
    if(kind==='home')return; // Returning home is an ordinary page navigation.
    if(!this.mounted){
      this.mounted=true;
      el('stage-output').append(document.querySelector('.output-section')!);
      el('stage-actions').append(el('run'),el('stop-run'));
      el('stage-notice').append(el('notice'));
      el('overlay-source').append(document.querySelector('.source-pane')!);
      el('overlay-sidebar').append(document.querySelector('.sidebar')!);
      el('overlay-file-actions').append(el('open-file'),el('new-source'),el('examples'));
      el('overlay-help').append(el('editor-help'));
      document.querySelector<HTMLElement>('.site-header')!.hidden=true;
      el('home').hidden=true;
      el('stage').hidden=false;
    }
    document.body.classList.add('program-view');
    document.body.classList.toggle('direct-view',kind==='direct');
    el('overlay').hidden=kind==='direct';
    if(kind==='workspace')this.expand(true,false);
    if(kind==='direct')this.expand(false,false);
    el('stage-title').textContent=kind==='workspace'?'Local draft':'Program';
  }
  expand(open:boolean,focus=true):void {
    const wasInside=this.panel.contains(document.activeElement);
    this.panel.hidden=!open;
    this.toggle.setAttribute('aria-expanded',String(open));
    this.toggle.setAttribute('aria-label',open?'Collapse editor':'Open editor');
    el('overlay-arrow').textContent=open?'⌃':'⌄';
    if(open){this.onExpand();if(focus)el('source').focus({preventScroll:true});}
    else if(wasInside&&focus)this.toggle.focus({preventScroll:true});
  }
  get editorOpen():boolean{return this.kind==='home'||(this.kind!=='direct'&&!this.panel.hidden);}
  get mayFocusProgram():boolean{
    const active=document.activeElement;
    return !this.panel.contains(active)&&!(active instanceof HTMLInputElement||active instanceof HTMLTextAreaElement);
  }
  identity(address:string|null,label:string,bytes:number):void {
    this.address=address;
    const parsed=address?parseAddress(address):null;
    const badge=el<HTMLButtonElement>('hash-badge');
    badge.hidden=!parsed;
    el('identity-empty').hidden=!!parsed;
    if(parsed){
      el('hash-grid').textContent=badgeRows(address!.split('_')[0]!);
      badge.title='Copy source address · '+address;
      badge.setAttribute('aria-label','Copy source address '+address);
    }
    el('identity-label').textContent=label;
    el('identity-bytes').textContent=bytes.toLocaleString()+' bytes';
    el<HTMLAnchorElement>('direct-link').hidden=!parsed;
    el<HTMLAnchorElement>('direct-link').href=parsed?'/run/'+address:'#';
    // The editor link is useful in direct view; it never claims a draft is published.
    el<HTMLAnchorElement>('stage-editor-link').hidden=this.kind!=='direct'||!parsed;
    el<HTMLAnchorElement>('stage-editor-link').href=parsed?'/r/'+address:'#';
  }
  get identityAddress():string|null{return this.address;}
  runBasis(label:string):void{el('run-basis').textContent=label;}
}
