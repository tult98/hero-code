/** CSS for sessions webview panel. Injected into `<style>` block. */
export const PANEL_CSS = `
* { box-sizing: border-box; }
html, body { height: 100%; }
body {
  margin: 0;
  padding: 0;
  background: var(--vscode-sideBar-background);
  color: var(--vscode-foreground);
  font-family: var(--vscode-font-family);
  font-size: var(--vscode-font-size);
}
@keyframes scpulse { 0%, 100% { opacity: 1; } 50% { opacity: .3; } }

.panel { display: flex; flex-direction: column; height: 100%; min-height: 0; }

/* ---- header ---- */
.header {
  height: 35px;
  flex: 0 0 35px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 10px 0 20px;
  color: var(--vscode-sideBarSectionHeader-foreground, var(--vscode-descriptionForeground));
  font-size: 11px;
  letter-spacing: .5px;
}
.header-actions { display: flex; align-items: center; gap: 13px; }
.header-actions .codicon { font-size: 14px; color: var(--vscode-descriptionForeground); }

/* ---- list ---- */
.list { flex: 1; min-height: 0; overflow-y: auto; padding: 4px 6px 8px; }
ul { list-style: none; margin: 0; padding: 0; }

/* ---- group ---- */
.group { margin-bottom: 3px; }
.group-head {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 8px 8px 5px 6px;
  color: var(--vscode-foreground);
}
.group-head .chevron { font-size: 14px; color: var(--vscode-descriptionForeground); }
.group-name {
  flex: 1;
  min-width: 0;
  font-size: 11.5px;
  font-weight: 700;
  letter-spacing: .2px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.group-actions { display: flex; align-items: center; gap: 11px; }
.group-actions .codicon { font-size: 14px; color: var(--vscode-descriptionForeground); }
.group-empty {
  padding: 3px 0 9px 23px;
  color: var(--vscode-descriptionForeground);
  font-size: 11.5px;
}

/* ---- session row ---- */
.session {
  display: flex;
  gap: 9px;
  padding: 9px 9px 9px 10px;
  border-radius: 7px;
  margin-bottom: 2px;
}
.ind { flex: 0 0 16px; display: flex; justify-content: center; padding-top: 2px; }
.ind .codicon { font-size: 14px; line-height: 14px; color: var(--vscode-descriptionForeground); }
.working .codicon { color: var(--vscode-charts-blue, #3794ff); }
.waiting .codicon { color: var(--vscode-charts-yellow, #e2b53d); animation: scpulse 1.4s ease-in-out infinite; }
.error .codicon { color: var(--vscode-charts-red, #f14c4c); }
.idle .codicon { color: var(--vscode-descriptionForeground); }

.body { flex: 1; min-width: 0; }
.head { display: flex; align-items: center; gap: 7px; }
.title {
  flex: 1;
  min-width: 0;
  font-size: 13px;
  font-weight: 600;
  color: var(--vscode-foreground);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.time { flex-shrink: 0; font-size: 10.5px; color: var(--vscode-descriptionForeground); white-space: nowrap; }

.branch {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-top: 2px;
  font-size: 10.5px;
  color: var(--vscode-descriptionForeground);
}
.branch .codicon { font-size: 11px; flex: 0 0 auto; }
.branch-name { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

.activity {
  font-size: 11.5px;
  color: var(--vscode-descriptionForeground);
  margin-top: 6px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.empty { padding: 14px 12px; color: var(--vscode-descriptionForeground); }
`
