/** The panel's stylesheet. A plain module (no Monaco) so the colour-contrast test can read it. */
export const STYLE = `
.dlq-qb{display:flex;flex-direction:column;height:100%;min-height:0;background:#1e1e1e;color:#ddd;font:13px system-ui,sans-serif;color-scheme:dark}
.dlq-qb button,.dlq-qb select,.dlq-qb input{font:inherit;color:#ddd;background:#2d2d30;border:1px solid #555;border-radius:3px;padding:2px 8px}
.dlq-qb button{cursor:pointer}.dlq-qb button:hover:not(:disabled){background:#3a3a3d}.dlq-qb button:disabled{color:#888;cursor:default}
.dlq-qb input::placeholder{color:#999}
.dlq-qb :focus-visible{outline:2px solid #4da3ff;outline-offset:1px}
.dlq-qb .qb-results:focus{outline:none}
.dlq-qb .problems{max-height:30%;overflow:auto;border-top:1px solid #333;border-bottom:1px solid #333;display:flex;flex-direction:column}
.dlq-qb .problems[hidden]{display:none}
.dlq-qb .problems .problem{text-align:left;border:0;border-radius:0;background:none;padding:3px 10px;white-space:pre-wrap}
.dlq-qb .problems .problem.error{color:#f48771}.dlq-qb .problems .problem.warning{color:#e2c08d}
.dlq-qb .problems .empty{padding:4px 10px;color:#999}
.dlq-qb header .has-errors{color:#f48771;border-color:#f48771}.dlq-qb header .has-warnings{color:#e2c08d;border-color:#e2c08d}
.dlq-qb th button.sort{border:0;background:none;padding:0;font-weight:600;text-align:left;width:100%}
.dlq-qb th input{width:100%;box-sizing:border-box;padding:1px 4px}
.dlq-qb td.num{text-align:right;font-variant-numeric:tabular-nums}
.dlq-qb tbody tr{cursor:pointer}.dlq-qb tbody tr:hover td{background:#2a2d2e}
.dlq-qb .pager{display:flex;gap:8px;align-items:center;margin:4px 0}
.dlq-qb .empty{color:#999;padding:4px 0}
@media (forced-colors:active){.dlq-qb tr.selected td{outline:2px solid Highlight;outline-offset:-2px}.dlq-qb :focus-visible{outline-color:Highlight}}
@media (prefers-reduced-motion:reduce){.dlq-qb *{scroll-behavior:auto!important;transition:none!important;animation:none!important}}
.dlq-qb header{display:flex;gap:8px;align-items:center;padding:6px 8px;border-bottom:1px solid #333}
.dlq-qb .qb-body{flex:1;display:flex;min-height:0}
.dlq-qb .qb-main{flex:1;display:flex;flex-direction:column;min-width:0;min-height:0}
.dlq-qb .qb-editor{height:40%;min-height:160px}
.dlq-qb .qb-results{flex:1;overflow:auto;padding:8px}
.dlq-qb .qb-side{width:340px;flex:none;display:flex;flex-direction:column;border-left:1px solid #333;min-height:0}
.dlq-qb .qb-side[hidden]{display:none}
.dlq-qb .qb-side .tabs{display:flex;gap:4px;padding:6px 8px;border-bottom:1px solid #333}
.dlq-qb .qb-side .tabs .active,.dlq-qb header .active{background:#264f78}
.dlq-qb .qb-side .pane{flex:1;min-height:0;overflow:auto;padding:8px;display:flex;flex-direction:column;gap:6px}
.dlq-qb .qb-side .pane[hidden]{display:none}
.dlq-qb .qb-side .docs{overflow:hidden}
.dlq-qb .doc-list{flex:0 1 45%;overflow:auto;display:flex;flex-direction:column;border:1px solid #333}
.dlq-qb .doc-list .cat{background:#252526;padding:2px 6px;font-weight:600;position:sticky;top:0}
.dlq-qb .doc-list .doc-item{text-align:left;background:none;border:0;color:inherit;padding:2px 10px;cursor:pointer;font:12px ui-monospace,monospace}
.dlq-qb .doc-list .doc-item:hover,.dlq-qb .doc-list .doc-item.selected{background:#264f78}
.dlq-qb .doc-detail{flex:1;overflow:auto}
.dlq-qb .doc-detail .kind{color:#999}
.dlq-qb .qb-side pre{background:#252526;padding:6px;margin:4px 0;overflow:auto;white-space:pre-wrap;font:12px ui-monospace,monospace}
.dlq-qb .card{border:1px solid #333;padding:8px;display:flex;flex-direction:column;gap:4px}
.dlq-qb .export-bar{display:flex;flex-wrap:wrap;gap:4px;align-items:center;margin-bottom:6px}
.dlq-qb .export-bar .provisional{color:#e2c08d}
.dlq-qb .notices .notice{padding:4px 8px;border-bottom:1px solid #333;display:flex;gap:8px;align-items:center}
.dlq-qb .notices .notice.warning{background:#5a4a1a}.dlq-qb .notices .notice.error{background:#5a1d1d}.dlq-qb .notices .notice.info{background:#1f3a52}
.dlq-qb .notices .notice input{flex:1;min-width:0}
.dlq-qb .notices .notice button{margin-left:auto}
.dlq-qb .qb-side input{min-width:0}.dlq-qb .qb-side .actions{flex-wrap:wrap}.dlq-qb .qb-side .empty{color:#999}
.dlq-qb .card p{margin:0}.dlq-qb .card .needs{color:#999}.dlq-qb .card .actions{display:flex;gap:6px}
.dlq-qb table{border-collapse:collapse}.dlq-qb th,.dlq-qb td{border:1px solid #333;padding:2px 8px;text-align:left}.dlq-qb th{background:#252526}
.dlq-qb tbody tr.selected td{background:#264f78}
.dlq-qb .error{color:#f48771;white-space:pre-wrap}.dlq-qb .warning{background:#5a4a1a;padding:2px 6px;margin:4px 0}
`
