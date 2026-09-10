/**
 * Client-side enhancement for the per-turn timeline: metric tabs, a hover
 * detail panel, and the cumulative-cost line. Inlined verbatim into the
 * generated dashboard, so it must not rely on any external resource.
 */
(function () {
  var dataEl = document.getElementById('turn-data');
  var svg = document.getElementById('timeline');
  var detail = document.getElementById('turn-detail');
  var legend = document.getElementById('tl-legend');
  var cum = document.getElementById('tl-cum');
  if (!dataEl || !svg || !detail || !legend) return;
  var TURNS;
  try { TURNS = JSON.parse(dataEl.textContent || '[]'); } catch (e) { TURNS = []; }
  if (!TURNS.length) return;

  var MAIN_TOP = 20, MAIN_BOTTOM = 240, MAIN_H = MAIN_BOTTOM - MAIN_TOP;
  var PAD_L = 58, PAD_R = 20, W = 1000, INNER_W = W - PAD_L - PAD_R;
  var N = Math.max(1, TURNS.length), SLOT = INNER_W / N;
  var BW = Math.max(3, Math.min(34, SLOT * 0.6));
  var COLORS = { input: '#7b8ef7', output: '#2fb8c6', cacheRead: '#3fae7d',
    cacheWrite: '#d9a441', cost: '#d9a441', time: '#a07ee0', speed: '#2fb8c6',
    cum: '#dce3f2', bad: '#e0616f', tools: '#d1798f' };
  var DEFAULT_METRIC = 'cost';
  var HINT = 'Hover a turn for token, cost, latency and tool details.';

  var groups = svg.querySelectorAll('.turn');
  var toolbars = svg.querySelectorAll('#tl-tools .toolbar');
  var ylabs = svg.querySelectorAll('.ylab');

  function xFor(i) { return PAD_L + SLOT * i + (SLOT - BW) / 2; }
  function maxOf(pick) {
    var m = 0;
    for (var i = 0; i < TURNS.length; i++) { var v = pick(TURNS[i]); if (v > m) m = v; }
    return m;
  }
  function fmtTokens(v) {
    if (!isFinite(v) || v <= 0) return '0';
    if (v < 1000) return String(Math.round(v));
    if (v < 10000) return (v / 1000).toFixed(1) + 'k';
    if (v < 1000000) return Math.round(v / 1000) + 'k';
    return (v / 1000000).toFixed(2) + 'M';
  }
  function fmtUsd(v) {
    if (!isFinite(v) || v <= 0) return '$0.00';
    if (v >= 1) return '$' + v.toFixed(2);
    if (v >= 0.01) return '$' + v.toFixed(3);
    return '$' + v.toFixed(4);
  }
  function fmtMs(v) {
    if (!isFinite(v) || v <= 0) return '0s';
    var s = v / 1000;
    if (s < 60) return s.toFixed(s < 10 ? 1 : 0) + 's';
    var m = Math.floor(s / 60);
    return m + 'm ' + Math.round(s % 60) + 's';
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function legendItem(color, label) {
    return '<span class="lg-item"><i style="background:' + color + '"></i>' + esc(label) + '</span>';
  }
  function legendFor(metric) {
    if (metric === 'tokens') return legendItem(COLORS.input, 'input') + legendItem(COLORS.output, 'output') + legendItem(COLORS.cacheRead, 'cache read') + legendItem(COLORS.cacheWrite, 'cache write') + legendItem(COLORS.tools, 'tool calls');
    if (metric === 'cost') return legendItem(COLORS.cost, 'cost / turn') + legendItem(COLORS.cum, 'cumulative') + legendItem(COLORS.tools, 'tool calls');
    if (metric === 'time') return legendItem(COLORS.time, 'generation time') + legendItem(COLORS.output, 'TTFT') + legendItem(COLORS.tools, 'tool calls');
    return legendItem(COLORS.speed, 'output tok/s') + legendItem(COLORS.tools, 'tool calls');
  }

  var METRICS = {
    tokens: { max: function () { return maxOf(function (t) { return t.totalTokens; }); }, fmt: fmtTokens },
    cost: { max: function () { return maxOf(function (t) { return t.cost; }); }, fmt: fmtUsd },
    time: { max: function () { return maxOf(function (t) { return t.durationMs; }); }, fmt: fmtMs },
    speed: { max: function () { return maxOf(function (t) { return t.tps; }); }, fmt: function (v) { return String(Math.round(v)); } }
  };

  function setMetric(metric) {
    var cfg = METRICS[metric] || METRICS.tokens;
    var max = cfg.max() || 1;
    var cumMax = maxOf(function (t) { return t.cumulativeCost; }) || 1;
    var pts = [];

    for (var l = 0; l < ylabs.length; l++) {
      ylabs[l].textContent = cfg.fmt(max * (1 - l / 4));
    }

    for (var i = 0; i < groups.length; i++) {
      var group = groups[i];
      var turn = TURNS[i];
      var stackedG = group.querySelector('.stacked');
      var solo = group.querySelector('.solo');
      var dot = group.querySelector('.ttft');
      if (metric === 'tokens') {
        if (stackedG) stackedG.style.display = '';
        solo.setAttribute('visibility', 'hidden');
        if (dot) dot.setAttribute('visibility', 'hidden');
      } else {
        if (stackedG) stackedG.style.display = 'none';
        var value = metric === 'cost' ? turn.cost : metric === 'time' ? turn.durationMs : turn.tps;
        var h = Math.max(value > 0 ? 2 : 0, (value / max) * MAIN_H);
        solo.setAttribute('y', (MAIN_BOTTOM - h).toFixed(1));
        solo.setAttribute('height', h.toFixed(1));
        solo.setAttribute('fill', turn.stopReason === 'error' ? COLORS.bad : COLORS[metric]);
        solo.setAttribute('visibility', 'visible');
        if (dot) {
          if (metric === 'time' && turn.ttftMs != null) {
            dot.setAttribute('cy', (MAIN_BOTTOM - (turn.ttftMs / max) * MAIN_H).toFixed(1));
            dot.setAttribute('visibility', 'visible');
          } else {
            dot.setAttribute('visibility', 'hidden');
          }
        }
      }
      var cy = MAIN_BOTTOM - (turn.cumulativeCost / cumMax) * MAIN_H * 0.94;
      pts.push((xFor(i) + BW / 2).toFixed(1) + ',' + cy.toFixed(1));
    }

    if (metric === 'cost' && pts.length > 1) {
      cum.setAttribute('points', pts.join(' '));
      cum.setAttribute('visibility', 'visible');
    } else {
      cum.setAttribute('visibility', 'hidden');
    }

    legend.innerHTML = legendFor(metric);
    var tabs = document.querySelectorAll('#tl-tabs .mtab');
    for (var k = 0; k < tabs.length; k++) {
      tabs[k].className = 'mtab' + (tabs[k].getAttribute('data-metric') === metric ? ' active' : '');
    }
  }

  function showDetail(i) {
    var t = TURNS[i];
    var when = t.timestamp ? new Date(t.timestamp).toLocaleTimeString() : '';
    var range = t.bucket && t.bucket > 1 ? 'Turns ' + t.index + '-' + (t.index + t.bucket - 1) : 'Turn ' + t.index;
    var tools = t.toolNames && t.toolNames.length ? t.toolNames.join(', ') : 'none';
    var stop = t.stopReason && t.stopReason !== 'toolUse' && t.stopReason !== 'stop' ? t.stopReason : '';
    var modelLabel = t.provider ? t.provider + '/' + t.model : t.model;
    function item(key, value) {
      return '<span class="td-item"><span class="td-key">' + key + '</span><b>' + esc(value) + '</b></span>';
    }
    var html = '<span class="td-title">' + esc(range) + '</span>';
    html += item('time', when) + item('model', modelLabel);
    html += '<span class="td-sep"></span>';
    html += item('in', fmtTokens(t.inputTokens)) + item('out', fmtTokens(t.outputTokens));
    html += item('cache R', fmtTokens(t.cacheReadTokens)) + item('total', fmtTokens(t.totalTokens));
    html += '<span class="td-sep"></span>';
    html += item('cost', fmtUsd(t.cost)) + item('cumulative', fmtUsd(t.cumulativeCost));
    html += '<span class="td-sep"></span>';
    html += item('gen', fmtMs(t.durationMs)) + item('ttft', t.ttftMs != null ? fmtMs(t.ttftMs) : 'n/a');
    html += item('speed', Math.round(t.tps) + ' tok/s');
    html += '<span class="td-sep"></span>';
    html += item('tools', t.toolCalls ? t.toolCalls + ' - ' + tools : 'none');
    if (stop) html += item('stop', stop);
    detail.innerHTML = html;
  }

  function clearDetail() {
    detail.innerHTML = '<span class="td-hint">' + HINT + '</span>';
    svg.classList.remove('dim');
    for (var i = 0; i < groups.length; i++) {
      groups[i].classList.remove('active');
      if (toolbars[i]) toolbars[i].classList.remove('active');
    }
  }

  function bind(el, i) {
    el.addEventListener('mouseenter', function () {
      svg.classList.add('dim');
      for (var k = 0; k < groups.length; k++) {
        groups[k].classList.toggle('active', k === i);
        if (toolbars[k]) toolbars[k].classList.toggle('active', k === i);
      }
      showDetail(i);
    });
  }

  for (var i = 0; i < groups.length; i++) {
    var hit = groups[i].querySelector('.hit');
    if (hit) bind(hit, i);
    if (toolbars[i]) bind(toolbars[i], i);
  }
  svg.addEventListener('mouseleave', clearDetail);

  var tabs = document.querySelectorAll('#tl-tabs .mtab');
  for (var j = 0; j < tabs.length; j++) {
    tabs[j].addEventListener('click', function () {
      setMetric(this.getAttribute('data-metric'));
    });
  }
  setMetric(DEFAULT_METRIC);
})();
