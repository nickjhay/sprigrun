// Independent workers keep solving/running away from the editor. One job owns
// its worker and termination always settles the job, even with late messages.
export interface WorkerPort {
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
  postMessage(message: unknown): void;
  terminate(): void;
}
export class WorkerJob {
  #active?: {worker:WorkerPort; reject:(reason:Error)=>void; timer:ReturnType<typeof setTimeout>};
  private readonly create:()=>WorkerPort;
  constructor(create:()=>WorkerPort) { this.create=create; }
  get busy():boolean { return this.#active !== undefined; }
  run<T>(message:unknown, timeoutMs:number, event?:(data:Record<string,unknown>)=>void):Promise<T> {
    this.cancel();
    return new Promise<T>((resolve,reject)=>{
      const worker=this.create();
      const finish=(error?:Error,value?:T)=>{
        if(this.#active?.worker!==worker)return;
        clearTimeout(this.#active.timer); this.#active=undefined;
        worker.terminate(); error?reject(error):resolve(value!);
      };
      const timer=setTimeout(()=>finish(new Error('Time limit reached.')),timeoutMs);
      this.#active={worker,reject:error=>finish(error),timer};
      worker.onmessage=({data})=>{
        if(this.#active?.worker!==worker || !data || typeof data!=='object')return;
        if(data.type==='done')finish(undefined,data.value as T);
        else if(data.type==='error')finish(new Error(typeof data.message==='string'?data.message.slice(0,4096):'Worker failed.'));
        else try { event?.(data as Record<string,unknown>); } catch(error) { finish(error instanceof Error?error:new Error('Unable to process worker output.')); }
      };
      worker.onerror=()=>finish(new Error('The worker could not start or encountered an error.'));
      try { worker.postMessage(message); } catch(error) { finish(error instanceof Error?error:new Error('Unable to start worker.')); }
    });
  }
  send(message:unknown):void { this.#active?.worker.postMessage(message); }
  cancel(message='Canceled.'):void { this.#active?.reject(new Error(message)); }
}
