import * as vscode from "vscode";
import { runAgent } from "./agent";

class AgentView implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private controller?: AbortController;
  constructor(private readonly context: vscode.ExtensionContext) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [] };
    view.webview.html = this.html(view.webview);
    view.webview.onDidReceiveMessage(async message => {
      switch (message?.type) {
        case "key":
          await vscode.commands.executeCommand("myCodingAgent.setApiKey");
          break;
        case "stop":
          this.controller?.abort();
          break;
        case "task":
          if (this.controller) return;
          if (typeof message.text !== "string" || !message.text.trim() || message.text.length > 10_000) return;
          const key = await this.context.secrets.get("myCodingAgent.openaiKey");
          if (!key) {
            this.post("error", "Спочатку натисни «API ключ» і збережи свій OpenAI API ключ.");
            return;
          }
          this.controller = new AbortController();
          this.post("busy", true);
          this.post("user", message.text.trim());
          try {
            const config = vscode.workspace.getConfiguration("myCodingAgent");
            await runAgent(message.text.trim(), key, config.get<string>("model", "gpt-5.4"),
              config.get<number>("maxSteps", 20), this.controller.signal,
              (kind, value) => this.post(kind, value));
          } catch (error) {
            this.post("error", error instanceof Error ? error.message : String(error));
          } finally {
            this.controller = undefined;
            this.post("busy", false);
          }
      }
    });
  }

  private post(type: string, value: unknown): void { void this.view?.webview.postMessage({ type, value }); }

  private html(webview: vscode.Webview): string {
    const nonce = Math.random().toString(36).slice(2);
    return `<!DOCTYPE html>
<html lang="uk"><head><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<style nonce="${nonce}">
  *{box-sizing:border-box}body{margin:0;color:var(--vscode-foreground);background:var(--vscode-sideBar-background);font:14px/1.5 var(--vscode-font-family);height:100vh;display:flex;flex-direction:column}
  header{padding:14px 14px 10px;border-bottom:1px solid var(--vscode-panel-border);display:flex;align-items:center;justify-content:space-between;gap:8px}
  h1{font-size:16px;margin:0}button{border:0;border-radius:9px;min-height:42px;padding:8px 12px;color:var(--vscode-button-foreground);background:var(--vscode-button-background);font:inherit;cursor:pointer}
  button:hover{background:var(--vscode-button-hoverBackground)}button:disabled{opacity:.5;cursor:default}.secondary{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}
  #log{flex:1;overflow:auto;padding:12px;min-height:100px}.entry{white-space:pre-wrap;overflow-wrap:anywhere;border:1px solid var(--vscode-panel-border);border-radius:11px;padding:10px 12px;margin-bottom:9px}
  .user{border-color:var(--vscode-focusBorder)}.tool,.info{font-size:12px;opacity:.8}.error{color:var(--vscode-errorForeground)}.label{font-size:11px;text-transform:uppercase;opacity:.65;margin-bottom:4px}
  form{padding:10px 12px max(12px,env(safe-area-inset-bottom));border-top:1px solid var(--vscode-panel-border);display:grid;gap:8px}
  textarea{resize:vertical;min-height:85px;max-height:35vh;width:100%;border:1px solid var(--vscode-input-border,var(--vscode-panel-border));border-radius:10px;padding:10px;color:var(--vscode-input-foreground);background:var(--vscode-input-background);font:inherit}
  .actions{display:flex;gap:8px}.actions button:first-child{flex:1}#stop{display:none}
</style></head><body>
<header><h1>My Coding Agent</h1><button id="key" class="secondary" type="button">API ключ</button></header>
<main id="log" aria-live="polite"><div class="entry">Відкрий папку проєкту та напиши завдання. Перед зміною файлів і запуском команд агент запитає дозвіл.</div></main>
<form id="form"><textarea id="task" placeholder="Наприклад: створи сторінку для мобільного екрана…" aria-label="Завдання"></textarea>
<div class="actions"><button id="send" type="submit">Запустити агента</button><button id="stop" class="secondary" type="button">Зупинити</button></div></form>
<script nonce="${nonce}">
const vscode=acquireVsCodeApi(),log=document.getElementById('log'),task=document.getElementById('task'),send=document.getElementById('send'),stop=document.getElementById('stop');
document.getElementById('key').onclick=()=>vscode.postMessage({type:'key'});
stop.onclick=()=>vscode.postMessage({type:'stop'});
document.getElementById('form').onsubmit=e=>{e.preventDefault();if(task.value.trim()){vscode.postMessage({type:'task',text:task.value});task.value='';}};
window.addEventListener('message',e=>{const {type,value}=e.data;if(type==='busy'){send.disabled=value;stop.style.display=value?'block':'none';return;}
const item=document.createElement('div');item.className='entry '+type;const label=document.createElement('div');label.className='label';label.textContent=({user:'Ти',tool:'Інструмент',info:'Результат',answer:'Агент',error:'Помилка'})[type]||type;
const body=document.createElement('div');body.textContent=String(value);item.append(label,body);log.append(item);log.scrollTop=log.scrollHeight;});
</script></body></html>`;
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const view = new AgentView(context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("myCodingAgent.chat", view),
    vscode.commands.registerCommand("myCodingAgent.open", () => vscode.commands.executeCommand("myCodingAgent.chat.focus")),
    vscode.commands.registerCommand("myCodingAgent.setApiKey", async () => {
      const key = await vscode.window.showInputBox({ prompt: "OpenAI API ключ", password: true, ignoreFocusOut: true });
      if (!key?.trim()) return;
      await context.secrets.store("myCodingAgent.openaiKey", key.trim());
      void vscode.window.showInformationMessage("API ключ збережено.");
    })
  );
}

export function deactivate(): void {}
