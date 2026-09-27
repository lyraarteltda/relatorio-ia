/**
 * Relatório IA — app logic
 * Fluxo: briefing de métricas → LLM (OpenRouter, JSON estruturado — SÓ a análise
 *        narrativa; os NÚMEROS vêm do usuário, então os gráficos são verdadeiros)
 *        → relatório com marca: capa + faixa de KPIs + gráficos SVG (tendência,
 *        engajamento, funil, mix de conteúdo) + seções escritas pela IA
 *        → export PDF (impressão) / HTML autocontido / texto.
 *
 * BYOK absoluto (Rule #1): a chave OpenRouter do próprio membro roda tudo, direto
 * do navegador → openrouter.ai. Nunca toca nosso backend.
 * COR-032/034/035/053: reroll em JSON inválido + reasoning:{effort:'low'} (menos
 * deepseek) + rede p/ content vazio + budget 16000. COR-015: normaliza null-like.
 */
const App = (function () {
  'use strict';

  var wired = false;
  var lastReport = null;   // { brief, data, derived }

  function $(id) { return document.getElementById(id); }

  // ---------- field helpers ----------
  function cleanField(v) {
    if (v === null || v === undefined) return '';
    var s = String(v).trim();
    var low = s.toLowerCase();
    if (low === 'null' || low === 'undefined' || low === 'n/a' || low === 'na' ||
        low === '-' || low === '—' || low === '') return '';
    return s;
  }
  function cleanArray(a) {
    if (!Array.isArray(a)) { var one = cleanField(a); return one ? [one] : []; }
    var out = []; a.forEach(function (x) { var c = cleanField(x); if (c) out.push(c); }); return out;
  }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function num(id) {
    var el = $(id); if (!el) return null;
    var v = String(el.value == null ? '' : el.value).trim().replace(/\./g, '').replace(',', '.');
    if (v === '') return null;
    var n = parseFloat(v);
    return isNaN(n) ? null : n;
  }
  function txt(id) { var el = $(id); return el ? String(el.value || '').trim() : ''; }
  function has(v) { return v !== null && v !== undefined && !(typeof v === 'number' && isNaN(v)); }

  function fmtInt(n) {
    if (!has(n)) return '—';
    try { return Math.round(n).toLocaleString('pt-BR'); }
    catch (e) { return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, '.'); }
  }
  function fmtBRL(n) {
    if (!has(n)) return '—';
    try { return n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }); }
    catch (e) { return 'R$ ' + (Math.round(n * 100) / 100).toFixed(2).replace('.', ','); }
  }
  function fmtPct(n, dec) {
    if (!has(n)) return '—';
    var d = dec == null ? 1 : dec;
    return (Math.round(n * Math.pow(10, d)) / Math.pow(10, d)).toFixed(d).replace('.', ',') + '%';
  }
  function fmtSigned(n) {
    if (!has(n)) return '—';
    return (n > 0 ? '+' : '') + fmtInt(n);
  }

  function toast(msg, kind) {
    var t = document.createElement('div');
    t.textContent = msg;
    t.style.cssText = 'position:fixed;left:50%;bottom:30px;transform:translateX(-50%);z-index:11000;' +
      'background:' + (kind === 'err' ? '#c33b3b' : '#141b2d') + ';color:#fff;padding:11px 18px;' +
      'border-radius:9px;font-size:14px;font-weight:600;box-shadow:0 8px 30px rgba(0,0,0,.22);max-width:88vw;text-align:center;';
    document.body.appendChild(t);
    setTimeout(function () { t.style.transition = 'opacity .4s'; t.style.opacity = '0'; }, 2600);
    setTimeout(function () { t.remove(); }, 3100);
  }

  // ---------- key / warning state ----------
  function syncKeyState() {
    var warn = $('no-key-warn');
    var btn = $('btn-generate');
    var okKeys = window.ApiKeyManager && ApiKeyManager.hasRequiredKeys();
    if (warn) warn.classList.toggle('show', !okKeys);
    if (btn) btn.disabled = !okKeys;
  }

  // ---------- JSON repair ladder (COR-032) ----------
  function stripToObject(s) {
    if (!s) return s;
    s = s.replace(/```(?:json)?/gi, '').replace(/```/g, '');
    var a = s.indexOf('{'), b = s.lastIndexOf('}');
    if (a >= 0 && b > a) s = s.slice(a, b + 1);
    return s.trim();
  }
  function parseJSON(raw) {
    if (!raw) throw new Error('empty');
    var s = stripToObject(raw);
    var tries = [
      function (x) { return x; },
      function (x) { return x.replace(/,\s*([}\]])/g, '$1'); },
      function (x) { return x.replace(/[\x00-\x1f]+/g, ' '); },
      function (x) { return x.replace(/,\s*([}\]])/g, '$1').replace(/[\x00-\x1f]+/g, ' ').replace(/“|”/g, '"').replace(/‘|’/g, "'"); }
    ];
    var err;
    for (var i = 0; i < tries.length; i++) {
      try { return JSON.parse(tries[i](s)); } catch (e) { err = e; }
    }
    throw err || new Error('parse');
  }

  // ---------- LLM call (OpenRouter) ----------
  function fetchContent(messages, opts) {
    opts = opts || {};
    var active = ApiKeyManager.getActiveKey();
    if (!active) return Promise.reject(new Error('Nenhuma chave configurada.'));
    var model = ApiKeyManager.getModel();
    var isDeepSeek = model.indexOf('deepseek/') === 0;
    var body = {
      model: model,
      messages: messages,
      temperature: opts.temperature != null ? opts.temperature : 0.55,
      max_tokens: opts.maxTokens || 16000   // COR-053: reasoning models reason by default
    };
    if (!isDeepSeek && !opts.noReasoning) body.reasoning = { effort: 'low' };  // COR-034/035

    return fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + active.key,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://relatorioia.maestrosdaia.com',
        'X-Title': 'Relatório IA'
      },
      body: JSON.stringify(body)
    }).then(function (resp) {
      return resp.json().catch(function () { return {}; }).then(function (data) {
        if (!resp.ok) {
          var em = (data && data.error && (data.error.message || data.error)) || ('HTTP ' + resp.status);
          if (resp.status === 401) em = 'Chave OpenRouter inválida ou sem permissão.';
          if (resp.status === 402) em = 'Créditos insuficientes na sua conta OpenRouter (adicione em openrouter.ai/credits).';
          if (resp.status === 429) em = 'Muitas requisições — aguarde um instante e tente de novo.';
          var e = new Error(em); e.httpStatus = resp.status; throw e;
        }
        var choice = (data.choices && data.choices[0]) || {};
        var content = choice.message && choice.message.content;
        if (!content || !String(content).trim()) {
          var empty = new Error('Resposta vazia do modelo.'); empty.emptyContent = true; throw empty;
        }
        return String(content);
      });
    });
  }
  function fetchResilient(messages, opts) {
    return fetchContent(messages, opts).catch(function (e) {
      if (e && e.emptyContent) { return fetchContent(messages, Object.assign({}, opts, { noReasoning: true })); }
      throw e;
    });
  }

  // ---------- prompt ----------
  var TOM_LABEL = {
    profissional: 'profissional e consultivo (como uma agência séria falando com o cliente)',
    direto: 'direto e objetivo, sem enrolação',
    caloroso: 'caloroso e próximo, mas ainda profissional'
  };

  function metricsBlock(b) {
    var L = [];
    function add(label, v, money) { if (has(v)) L.push('- ' + label + ': ' + (money ? fmtBRL(v) : fmtInt(v))); }
    add('Seguidores no início', b.segIni);
    add('Seguidores no fim', b.segFim);
    if (has(b.segIni) && has(b.segFim)) L.push('- Crescimento de seguidores: ' + fmtSigned(b.segFim - b.segIni) + (b.segIni ? ' (' + fmtPct((b.segFim - b.segIni) / b.segIni * 100) + ')' : ''));
    add('Alcance/impressões no período', b.alcance);
    add('Alcance no período anterior', b.alcanceAnt);
    add('Curtidas', b.curtidas); add('Comentários', b.comentarios);
    add('Compartilhamentos', b.compart); add('Salvamentos', b.salvos);
    if (has(b.interacoes)) L.push('- Interações totais: ' + fmtInt(b.interacoes));
    if (has(b.taxaEng)) L.push('- Taxa de engajamento (interações/alcance): ' + fmtPct(b.taxaEng));
    add('Posts no feed', b.posts); add('Reels', b.reels); add('Stories', b.stories);
    add('Cliques/visitas ao site', b.visitas); add('Leads/contatos', b.leads);
    add('Vendas/conversões', b.vendas); add('Investimento em anúncios', b.invest, true);
    add('Receita/faturamento', b.receita, true);
    if (has(b.roas)) L.push('- ROAS (receita/investimento): ' + (Math.round(b.roas * 100) / 100).toFixed(2).replace('.', ',') + 'x');
    if (b.topposts.length) L.push('- Top conteúdos: ' + b.topposts.map(function (t) { return t.nome + (t.metric ? ' (' + t.metric + ')' : ''); }).join('; '));
    return L.length ? L.join('\n') : '(nenhuma métrica numérica informada)';
  }

  function buildMessages(b) {
    var sys = 'Você é um(a) analista de marketing e social media sênior de uma agência brasileira. ' +
      'Você escreve relatórios de resultados claros, honestos e acionáveis para o CLIENTE ler. ' +
      'Escreva SEMPRE em português do Brasil, com acentuação correta, em tom ' + (TOM_LABEL[b.tom] || TOM_LABEL.profissional) + '. ' +
      'REGRA CRÍTICA: use SOMENTE os números fornecidos — NUNCA invente métricas, percentuais ou valores que não foram dados. ' +
      'Você pode calcular relações a partir dos números dados (ex.: variação %, taxa de engajamento) e interpretar, mas não fabrique dados. ' +
      'Se um dado não foi informado, não o cite. Refira-se ao cliente pelo nome. Sem emojis. ' +
      'Sua saída é EXCLUSIVAMENTE um objeto JSON válido (sem markdown, sem texto fora do JSON, aspas retas ").';

    var schema =
      '{\n' +
      '  "titulo": "linha curta de subtítulo para a capa (ex.: Desempenho nas redes sociais)",\n' +
      '  "resumo_executivo": "1 parágrafo (3 a 5 frases) com a leitura geral do período: o que aconteceu, o que foi bem, o que precisa de atenção. Cite os números-chave.",\n' +
      '  "analise_crescimento": "1 parágrafo sobre alcance e crescimento de audiência (só se houver dados de alcance/seguidores; senão string vazia)",\n' +
      '  "analise_conteudo": "1 parágrafo sobre engajamento e conteúdo: o que engajou, formatos, qualidade da interação (só se houver dados de engajamento/publicações; senão vazio)",\n' +
      '  "analise_conversao": "1 parágrafo sobre tráfego, leads, vendas e retorno do investimento (só se houver dados de conversão; senão vazio)",\n' +
      '  "destaques": ["2 a 4 destaques/vitórias concretas do período, frases curtas"],\n' +
      '  "recomendacoes": ["3 a 5 próximos passos acionáveis e específicos para o próximo período, frases curtas no imperativo"]\n' +
      '}';

    var user =
      'Escreva a ANÁLISE de um relatório de resultados para o cliente abaixo. Os gráficos e os números são montados à parte a partir das métricas — sua função é a NARRATIVA (resumo e análises).\n\n' +
      'Cliente/marca: ' + b.cliente + '\n' +
      'Período: ' + b.periodo + '\n' +
      'Foco: ' + b.canal + '\n' +
      (b.segmento ? 'Nicho/segmento: ' + b.segmento + '\n' : '') +
      '\nMÉTRICAS DO PERÍODO (use apenas estas):\n' + metricsBlock(b) + '\n' +
      (b.destaquesTxt ? '\nDestaques informados pelo gestor: ' + b.destaquesTxt + '\n' : '') +
      (b.obs ? '\nContexto/ações do período (para interpretar os números): ' + b.obs + '\n' : '') +
      '\nRegras:\n' +
      '- Preencha analise_crescimento / analise_conteudo / analise_conversao só quando houver dados daquela área; caso contrário devolva string vazia "".\n' +
      '- Seja específico para ESTE cliente e período; nada genérico. Interprete os números (o porquê), não apenas os repita.\n' +
      '- recomendacoes: próximos passos práticos para o próximo período, coerentes com os dados.\n' +
      'Responda somente com o JSON no formato:\n' + schema;

    return [{ role: 'system', content: sys }, { role: 'user', content: user }];
  }

  // ---------- collect brief ----------
  function collectBrief() {
    var topRaw = txt('f-toppost');
    var topposts = topRaw ? topRaw.split(/\n+/).map(function (line) {
      var parts = line.split('|');
      return { nome: cleanField(parts[0]), metric: cleanField(parts[1]) };
    }).filter(function (t) { return t.nome; }) : [];

    var serieRaw = txt('f-serie');
    var serie = serieRaw ? serieRaw.split(/[,;]+/).map(function (x) {
      var v = parseFloat(String(x).trim().replace(/\./g, '').replace(',', '.'));
      return isNaN(v) ? null : v;
    }).filter(function (v) { return v !== null; }) : [];
    var serieLabelsRaw = txt('f-serie-labels');
    var serieLabels = serieLabelsRaw ? serieLabelsRaw.split(/[,;]+/).map(function (x) { return x.trim(); }).filter(Boolean) : [];

    var b = {
      cliente: txt('f-cliente'),
      periodo: txt('f-periodo'),
      canal: txt('f-canal') || 'Instagram',
      preparado: txt('f-preparado'),
      segmento: txt('f-segmento'),
      segIni: num('f-seg-ini'), segFim: num('f-seg-fim'),
      alcance: num('f-alcance'), alcanceAnt: num('f-alcance-ant'),
      serie: serie, serieLabels: serieLabels,
      curtidas: num('f-curtidas'), comentarios: num('f-comentarios'),
      compart: num('f-compart'), salvos: num('f-salvos'),
      posts: num('f-posts'), reels: num('f-reels'), stories: num('f-stories'),
      topposts: topposts,
      visitas: num('f-visitas'), leads: num('f-leads'), vendas: num('f-vendas'),
      invest: num('f-invest'), receita: num('f-receita'),
      destaquesTxt: txt('f-destaques'), obs: txt('f-obs'),
      tom: txt('f-tom') || 'profissional'
    };

    // derived
    var interacoes = 0, anyEng = false;
    ['curtidas', 'comentarios', 'compart', 'salvos'].forEach(function (k) { if (has(b[k])) { interacoes += b[k]; anyEng = true; } });
    b.interacoes = anyEng ? interacoes : null;
    b.taxaEng = (has(b.alcance) && b.alcance > 0 && has(b.interacoes)) ? (b.interacoes / b.alcance * 100) : null;
    b.roas = (has(b.receita) && has(b.invest) && b.invest > 0) ? (b.receita / b.invest) : null;
    b.pubTotal = (has(b.posts) || has(b.reels) || has(b.stories)) ? ((b.posts || 0) + (b.reels || 0) + (b.stories || 0)) : null;
    b.growth = (has(b.segIni) && has(b.segFim)) ? (b.segFim - b.segIni) : null;
    b.growthPct = (has(b.growth) && has(b.segIni) && b.segIni > 0) ? (b.growth / b.segIni * 100) : null;
    b.alcancePct = (has(b.alcance) && has(b.alcanceAnt) && b.alcanceAnt > 0) ? ((b.alcance - b.alcanceAnt) / b.alcanceAnt * 100) : null;
    return b;
  }

  function hasAnyMetric(b) {
    return ['segIni', 'segFim', 'alcance', 'curtidas', 'comentarios', 'compart', 'salvos',
      'posts', 'reels', 'stories', 'visitas', 'leads', 'vendas', 'invest', 'receita'].some(function (k) { return has(b[k]); })
      || b.serie.length > 0 || b.topposts.length > 0;
  }

  // ---------- generate ----------
  function generate() {
    var b = collectBrief();
    if (!b.cliente || !b.periodo) { toast('Preencha o cliente e o período.', 'err'); return; }
    if (!hasAnyMetric(b)) { toast('Informe ao menos uma métrica (ex.: alcance, seguidores ou engajamento).', 'err'); return; }
    if (!(window.ApiKeyManager && ApiKeyManager.hasRequiredKeys())) { syncKeyState(); toast('Adicione sua chave OpenRouter primeiro.', 'err'); return; }

    setBusy(true);
    var messages = buildMessages(b);

    var run = function () {
      return fetchResilient(messages, { temperature: 0.55, maxTokens: 16000 })
        .then(function (raw) {
          try { return parseJSON(raw); }
          catch (e) {
            var strict = messages.concat([
              { role: 'assistant', content: raw.slice(0, 400) },
              { role: 'user', content: 'Sua resposta anterior NÃO era um JSON válido. Responda NOVAMENTE apenas com o objeto JSON pedido, com aspas retas ("), sem markdown e sem texto fora do JSON.' }
            ]);
            return fetchResilient(strict, { temperature: 0.4, maxTokens: 16000 }).then(function (t2) { return parseJSON(t2); });
          }
        });
    };
    var wrapped = (window.RateLimiter && RateLimiter.executeWithLimit)
      ? RateLimiter.executeWithLimit('generate', run) : run();

    Promise.resolve(wrapped).then(function (data) {
      lastReport = { brief: b, data: normalizeData(data) };
      renderReport(lastReport);
      setBusy(false);
    }).catch(function (e) {
      setBusy(false);
      var msg = (e && e.message) ? e.message : 'Erro ao gerar o relatório.';
      if (/rate limit exceeded|too many/i.test(msg)) msg = 'Muitas gerações seguidas. Aguarde um instante.';
      toast(msg, 'err');
      console.error('[relatorio] generate error:', e);
    });
  }

  function normalizeData(d) {
    d = d || {};
    return {
      titulo: cleanField(d.titulo) || 'Relatório de resultados',
      resumo: cleanField(d.resumo_executivo),
      crescimento: cleanField(d.analise_crescimento),
      conteudo: cleanField(d.analise_conteudo),
      conversao: cleanField(d.analise_conversao),
      destaques: cleanArray(d.destaques),
      recomendacoes: cleanArray(d.recomendacoes)
    };
  }

  function setBusy(b) {
    var btn = $('btn-generate');
    if (btn) {
      btn.disabled = b || !(window.ApiKeyManager && ApiKeyManager.hasRequiredKeys());
      btn.querySelector('.btn-text').style.display = b ? 'none' : 'inline';
      btn.querySelector('.btn-loading').style.display = b ? 'inline' : 'none';
    }
    $('stage-loading').hidden = !b;
    if (b) { $('stage-empty').hidden = true; $('stage-toolbar').hidden = true; $('report').hidden = true; cycleLoading(); }
  }
  var _loadTimer = null;
  function cycleLoading() {
    var steps = ['lendo as métricas', 'calculando variações', 'desenhando os gráficos', 'escrevendo a análise', 'montando o relatório'];
    var i = 0; var el = $('loading-mono');
    if (_loadTimer) clearInterval(_loadTimer);
    _loadTimer = setInterval(function () {
      if (!el || $('stage-loading').hidden) { clearInterval(_loadTimer); return; }
      el.textContent = steps[i % steps.length] + '…'; i++;
    }, 900);
  }

  // ================= SVG CHART BUILDERS (duotone: navy/steel + gold; deltas green/red) =================
  var C_STEEL = '#34506f', C_STEEL_2 = '#7d99b5', C_GOLD = '#b0894f', C_GRID = '#e6eaf0',
      C_INK = '#141b2d', C_MUTE = '#7e8aa0', C_POS = '#12915a', C_NEG = '#c33b3b';

  function svgOpen(w, h, label) {
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + w + ' ' + h + '" width="' + w + '" height="' + h + '" role="img" aria-label="' + esc(label) + '">' +
      '<style>text{font-family:Arial,Helvetica,sans-serif}.lbl{font-size:11px;fill:' + C_MUTE + '}.val{font-size:11px;font-weight:700;fill:' + C_INK + '}.cat{font-size:11.5px;fill:' + C_INK + '}</style>';
  }
  function niceMax(v) {
    if (v <= 0) return 10;
    var mag = Math.pow(10, Math.floor(Math.log10(v)));
    var n = v / mag;
    var step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
    return step * mag;
  }
  function abbr(n) {
    n = Math.round(n);
    if (Math.abs(n) >= 1000000) return (n / 1000000).toFixed(n % 1000000 ? 1 : 0).replace('.', ',') + 'M';
    if (Math.abs(n) >= 1000) return (n / 1000).toFixed(n % 1000 ? 1 : 0).replace('.', ',') + 'k';
    return String(n);
  }

  // Trend line/area
  function chartTrend(series, labels) {
    var W = 520, H = 210, padL = 46, padR = 16, padT = 14, padB = 30;
    var n = series.length;
    var maxV = niceMax(Math.max.apply(null, series));
    var plotW = W - padL - padR, plotH = H - padT - padB;
    var xOf = function (i) { return padL + (n === 1 ? plotW / 2 : (i / (n - 1)) * plotW); };
    var yOf = function (v) { return padT + plotH - (v / maxV) * plotH; };
    var p = [svgOpen(W, H, 'Evolução no período')];
    // grid + y labels
    for (var g = 0; g <= 4; g++) {
      var yv = maxV * g / 4, y = yOf(yv);
      p.push('<line x1="' + padL + '" y1="' + y + '" x2="' + (W - padR) + '" y2="' + y + '" stroke="' + C_GRID + '" stroke-width="1"/>');
      p.push('<text x="' + (padL - 6) + '" y="' + (y + 3.5) + '" text-anchor="end" class="lbl">' + abbr(yv) + '</text>');
    }
    // area
    var line = series.map(function (v, i) { return xOf(i) + ',' + yOf(v); });
    var area = 'M' + padL + ',' + yOf(0) + ' L' + line.join(' L') + ' L' + xOf(n - 1) + ',' + yOf(0) + ' Z';
    p.push('<path d="' + area + '" fill="' + C_STEEL + '" fill-opacity="0.10"/>');
    p.push('<polyline points="' + line.join(' ') + '" fill="none" stroke="' + C_STEEL + '" stroke-width="2.4" stroke-linejoin="round" stroke-linecap="round"/>');
    series.forEach(function (v, i) {
      var last = i === n - 1;
      p.push('<circle cx="' + xOf(i) + '" cy="' + yOf(v) + '" r="' + (last ? 4.5 : 3) + '" fill="' + (last ? C_GOLD : C_STEEL) + '"/>');
      if (last || n <= 6) p.push('<text x="' + xOf(i) + '" y="' + (yOf(v) - 8) + '" text-anchor="middle" class="val">' + abbr(v) + '</text>');
      var lab = labels[i] || ('P' + (i + 1));
      p.push('<text x="' + xOf(i) + '" y="' + (H - 10) + '" text-anchor="middle" class="lbl">' + esc(lab.length > 8 ? lab.slice(0, 8) : lab) + '</text>');
    });
    p.push('</svg>');
    return p.join('');
  }

  // Two-bar before/after
  function chartBeforeAfter(a, bV, la, lb) {
    var W = 520, H = 210, padT = 24, padB = 34, padL = 20, padR = 20;
    var maxV = niceMax(Math.max(a, bV));
    var plotH = H - padT - padB;
    var bw = 120, gap = 90, cx = W / 2;
    var x1 = cx - gap / 2 - bw, x2 = cx + gap / 2;
    var yOf = function (v) { return padT + plotH - (v / maxV) * plotH; };
    var base = padT + plotH;
    var p = [svgOpen(W, H, 'Antes e depois')];
    function bar(x, v, color, label) {
      var y = yOf(v);
      p.push('<rect x="' + x + '" y="' + y + '" width="' + bw + '" height="' + (base - y) + '" rx="6" fill="' + color + '"/>');
      p.push('<text x="' + (x + bw / 2) + '" y="' + (y - 8) + '" text-anchor="middle" class="val" style="font-size:14px">' + fmtInt(v) + '</text>');
      p.push('<text x="' + (x + bw / 2) + '" y="' + (base + 18) + '" text-anchor="middle" class="cat">' + esc(label) + '</text>');
    }
    p.push('<line x1="' + padL + '" y1="' + base + '" x2="' + (W - padR) + '" y2="' + base + '" stroke="' + C_GRID + '" stroke-width="1"/>');
    bar(x1, a, C_STEEL_2, la);
    bar(x2, bV, C_STEEL, lb);
    p.push('</svg>');
    return p.join('');
  }

  // Horizontal bars
  function chartHBars(items, heroIdx) {
    var W = 520, rowH = 34, padT = 8, padB = 6, padL = 118, padR = 54;
    var H = padT + padB + items.length * rowH;
    var maxV = niceMax(Math.max.apply(null, items.map(function (i) { return i.value; })));
    var plotW = W - padL - padR;
    var p = [svgOpen(W, H, 'Composição')];
    items.forEach(function (it, i) {
      var y = padT + i * rowH + rowH / 2;
      var bw = maxV > 0 ? (it.value / maxV) * plotW : 0;
      var color = (i === heroIdx) ? C_GOLD : C_STEEL;
      p.push('<text x="' + (padL - 10) + '" y="' + (y + 4) + '" text-anchor="end" class="cat">' + esc(it.label) + '</text>');
      p.push('<rect x="' + padL + '" y="' + (y - 10) + '" width="' + Math.max(2, bw) + '" height="20" rx="5" fill="' + color + '"/>');
      p.push('<text x="' + (padL + Math.max(2, bw) + 8) + '" y="' + (y + 4) + '" class="val">' + fmtInt(it.value) + '</text>');
    });
    p.push('</svg>');
    return p.join('');
  }

  // Funnel (steps top→down)
  function chartFunnel(steps) {
    var W = 520, rowH = 46, padT = 10, padB = 10, padX = 20;
    var H = padT + padB + steps.length * rowH;
    var maxV = Math.max.apply(null, steps.map(function (s) { return s.value; }));
    var fullW = W - padX * 2;
    var p = [svgOpen(W, H, 'Funil de resultados')];
    steps.forEach(function (s, i) {
      var y = padT + i * rowH + 6;
      var w = maxV > 0 ? Math.max(60, (s.value / maxV) * fullW) : 60;
      var x = (W - w) / 2;
      var color = i === 0 ? C_STEEL_2 : (i === steps.length - 1 ? C_GOLD : C_STEEL);
      p.push('<rect x="' + x + '" y="' + y + '" width="' + w + '" height="' + (rowH - 14) + '" rx="5" fill="' + color + '"/>');
      p.push('<text x="' + (W / 2) + '" y="' + (y + (rowH - 14) / 2 + 4) + '" text-anchor="middle" style="font-size:12.5px;font-weight:700;fill:#fff">' + esc(s.label) + ': ' + fmtInt(s.value) + '</text>');
      if (i > 0 && steps[i - 1].value > 0) {
        var conv = s.value / steps[i - 1].value * 100;
        p.push('<text x="' + (W - padX) + '" y="' + (y + (rowH - 14) / 2 + 4) + '" text-anchor="end" class="lbl">' + fmtPct(conv, conv < 10 ? 1 : 0) + '</text>');
      }
    });
    p.push('</svg>');
    return p.join('');
  }

  // ================= RENDER REPORT =================
  function kpiCard(label, value, deltaHTML, sub) {
    return '<div class="kpi"><div class="kpi-label">' + esc(label) + '</div>' +
      '<div class="kpi-value">' + value + '</div>' +
      '<div class="kpi-sub">' + (deltaHTML || '') + (sub ? (deltaHTML ? ' ' : '') + esc(sub) : '') + '</div></div>';
  }
  function deltaChip(delta, pct) {
    if (!has(delta)) return '';
    var cls = delta > 0 ? 'up' : (delta < 0 ? 'down' : 'flat');
    var arrow = delta > 0 ? '▲' : (delta < 0 ? '▼' : '■');
    var t = arrow + ' ' + fmtSigned(delta);
    if (has(pct)) t += ' (' + (pct > 0 ? '+' : '') + fmtPct(pct) + ')';
    return '<span class="delta ' + cls + '">' + t + '</span>';
  }

  function buildReportHTML(r) {
    var b = r.brief, d = r.data;
    var H = [];

    // cover
    H.push('<div class="rp-cover">');
    H.push('<svg class="rp-seal" viewBox="0 0 48 48" fill="none"><circle cx="24" cy="24" r="21" stroke="#b0894f" stroke-width="1.4"/><circle cx="24" cy="24" r="16" stroke="#e9dcc3" stroke-width="1"/><path d="M16 27 L22 21 L28 25 L33 18" stroke="#34506f" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round"/><circle cx="16" cy="27" r="1.6" fill="#b0894f"/><circle cx="33" cy="18" r="1.6" fill="#b0894f"/></svg>');
    H.push('<div class="rp-kicker">Relatório de resultados</div>');
    H.push('<div class="rp-client">' + esc(b.cliente) + '</div>');
    var tagline = d.titulo && d.titulo.toLowerCase().indexOf((b.periodo || '').toLowerCase()) < 0 ? d.titulo : '';
    H.push('<div class="rp-period">' + esc(b.periodo) + ' · ' + esc(b.canal) + (tagline ? ' — ' + esc(tagline) : '') + '</div>');
    H.push('<div class="rp-prepared">');
    if (b.preparado) H.push('<span><b>Preparado por:</b> ' + esc(b.preparado) + '</span>');
    if (b.segmento) H.push('<span><b>Segmento:</b> ' + esc(b.segmento) + '</span>');
    H.push('<span><b>Emitido em:</b> ' + esc(todayStr()) + '</span>');
    H.push('</div></div>');

    // KPI band
    var kpis = [];
    if (has(b.segFim) || has(b.segIni)) {
      kpis.push(kpiCard('Seguidores', fmtInt(has(b.segFim) ? b.segFim : b.segIni),
        (has(b.growth) ? deltaChip(b.growth, b.growthPct) : ''), has(b.growth) ? 'no período' : ''));
    }
    if (has(b.alcance)) {
      kpis.push(kpiCard('Alcance', fmtInt(b.alcance),
        (has(b.alcancePct) ? deltaChip(b.alcance - b.alcanceAnt, b.alcancePct) : ''), 'impressões'));
    }
    if (has(b.taxaEng)) {
      kpis.push(kpiCard('Engajamento', fmtPct(b.taxaEng), '', fmtInt(b.interacoes) + ' interações'));
    } else if (has(b.interacoes)) {
      kpis.push(kpiCard('Interações', fmtInt(b.interacoes), '', 'curtidas, coment., etc.'));
    }
    if (has(b.pubTotal)) {
      kpis.push(kpiCard('Publicações', fmtInt(b.pubTotal), '', pubBreakdown(b)));
    }
    if (has(b.leads)) kpis.push(kpiCard('Leads', fmtInt(b.leads), '', has(b.visitas) ? 'de ' + fmtInt(b.visitas) + ' visitas' : ''));
    if (has(b.vendas)) kpis.push(kpiCard('Vendas', fmtInt(b.vendas), '', has(b.receita) ? fmtBRL(b.receita) : ''));
    else if (has(b.receita)) kpis.push(kpiCard('Receita', fmtBRL(b.receita), '', has(b.roas) ? 'ROAS ' + roasStr(b.roas) : ''));
    if (has(b.roas) && !(has(b.vendas) || has(b.receita) && false)) { /* roas shown in vendas/receita card */ }

    if (kpis.length) H.push('<div class="rp-kpis">' + kpis.join('') + '</div>');

    var secNum = 0;
    function sec(title, bodyHTML) {
      secNum++;
      return '<div class="rp-section"><h3 class="rp-h"><span class="rp-h-num">' +
        (secNum < 10 ? '0' + secNum : secNum) + '</span>' + esc(title) + '</h3>' + bodyHTML + '</div>';
    }

    // Executive summary
    if (d.resumo) H.push(sec('Resumo executivo', '<p class="rp-p">' + esc(d.resumo) + '</p>'));

    // Charts block (only those with data)
    var charts = [];
    if (b.serie.length >= 2) charts.push(chartCardHTML('Evolução no período', b.serieLabels.length ? '' : 'valores informados na ordem', chartTrend(b.serie, b.serieLabels)));
    if (has(b.segIni) && has(b.segFim)) charts.push(chartCardHTML('Seguidores: início → fim', 'crescimento de ' + fmtSigned(b.growth), chartBeforeAfter(b.segIni, b.segFim, 'Início', 'Fim')));
    var engItems = [];
    if (has(b.curtidas)) engItems.push({ label: 'Curtidas', value: b.curtidas });
    if (has(b.comentarios)) engItems.push({ label: 'Comentários', value: b.comentarios });
    if (has(b.compart)) engItems.push({ label: 'Compartilh.', value: b.compart });
    if (has(b.salvos)) engItems.push({ label: 'Salvamentos', value: b.salvos });
    if (engItems.length >= 1) {
      var heroIdx = engItems.reduce(function (mi, it, i, arr) { return it.value > arr[mi].value ? i : mi; }, 0);
      charts.push(chartCardHTML('Composição do engajamento', fmtInt(b.interacoes) + ' interações no total', chartHBars(engItems, heroIdx)));
    }
    var funnelSteps = [];
    if (has(b.alcance)) funnelSteps.push({ label: 'Alcance', value: b.alcance });
    if (has(b.interacoes)) funnelSteps.push({ label: 'Interações', value: b.interacoes });
    if (has(b.visitas)) funnelSteps.push({ label: 'Visitas', value: b.visitas });
    if (has(b.leads)) funnelSteps.push({ label: 'Leads', value: b.leads });
    if (has(b.vendas)) funnelSteps.push({ label: 'Vendas', value: b.vendas });
    if (funnelSteps.length >= 2) charts.push(chartCardHTML('Funil de resultados', 'do alcance à conversão', chartFunnel(funnelSteps)));
    var mixItems = [];
    if (has(b.posts)) mixItems.push({ label: 'Posts', value: b.posts });
    if (has(b.reels)) mixItems.push({ label: 'Reels', value: b.reels });
    if (has(b.stories)) mixItems.push({ label: 'Stories', value: b.stories });
    if (mixItems.length >= 2) charts.push(chartCardHTML('Mix de conteúdo', fmtInt(b.pubTotal) + ' publicações', chartHBars(mixItems, -1)));

    if (charts.length) {
      H.push('<div class="rp-section"><h3 class="rp-h"><span class="rp-h-num">' + pad2(++secNum) + '</span>Números do período</h3>' +
        '<div class="rp-charts' + (charts.length === 1 ? ' one' : '') + '">' + charts.join('') + '</div></div>');
    }

    // Analyses
    if (d.crescimento) H.push(sec('Crescimento & alcance', '<p class="rp-p">' + esc(d.crescimento) + '</p>'));
    if (d.conteudo) H.push(sec('Conteúdo & engajamento', '<p class="rp-p">' + esc(d.conteudo) + '</p>'));
    if (d.conversao) H.push(sec('Conversão & resultados', '<p class="rp-p">' + esc(d.conversao) + '</p>'));

    // Top posts table
    if (b.topposts.length) {
      var rows = b.topposts.map(function (t) {
        return '<tr><td>' + esc(t.nome) + '</td><td class="num">' + esc(t.metric || '—') + '</td></tr>';
      }).join('');
      H.push(sec('Destaques de conteúdo', '<table class="rp-table"><thead><tr><th>Conteúdo</th><th class="num">Métrica</th></tr></thead><tbody>' + rows + '</tbody></table>'));
    }

    // Highlights
    if (d.destaques.length) {
      H.push(sec('Destaques do período', '<ul class="rp-list">' + d.destaques.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul>'));
    }

    // Recommendations
    if (d.recomendacoes.length) {
      H.push(sec('Próximos passos', '<ul class="rp-list checks">' + d.recomendacoes.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul>'));
    }

    // footer
    H.push('<div class="rp-foot"><span>' + esc(b.cliente) + ' · ' + esc(b.periodo) + '</span><span class="rp-foot-brand">Relatório IA · Maestros da IA</span></div>');

    return H.join('');
  }

  function pad2(n) { return n < 10 ? '0' + n : String(n); }
  function pubBreakdown(b) {
    var parts = [];
    if (has(b.posts)) parts.push(b.posts + ' posts');
    if (has(b.reels)) parts.push(b.reels + ' reels');
    if (has(b.stories)) parts.push(b.stories + ' stories');
    return parts.join(' · ');
  }
  function roasStr(r) { return (Math.round(r * 100) / 100).toFixed(2).replace('.', ',') + 'x'; }
  function chartCardHTML(title, note, svg) {
    return '<div class="chart-card"><p class="chart-title">' + esc(title) + '</p>' +
      (note ? '<p class="chart-note">' + esc(note) + '</p>' : '') + svg + '</div>';
  }
  function todayStr() {
    var d = new Date();
    var mes = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
    return ('0' + d.getDate()).slice(-2) + ' ' + mes[d.getMonth()] + ' ' + d.getFullYear();
  }

  function renderReport(r) {
    $('report-inner').innerHTML = buildReportHTML(r);
    $('report').hidden = false;
    $('stage-empty').hidden = true;
    $('stage-toolbar').hidden = false;
    $('tb-title').textContent = r.brief.cliente + ' — ' + r.brief.periodo;
    var nCharts = $('report-inner').querySelectorAll('.chart-card').length;
    $('tb-code').textContent = (nCharts ? nCharts + ' GRÁFICO' + (nCharts > 1 ? 'S' : '') + ' · ' : '') +
      $('report-inner').querySelectorAll('.rp-section').length + ' SEÇÕES';
    if (window.matchMedia && window.matchMedia('(max-width: 980px)').matches) {
      $('report').scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }

  // ================= EXPORT =================
  function fileBase() {
    var c = (lastReport && lastReport.brief.cliente ? lastReport.brief.cliente : 'relatorio').toLowerCase()
      .normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    var p = (lastReport && lastReport.brief.periodo ? lastReport.brief.periodo : '').toLowerCase()
      .normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    return 'relatorio-' + (c || 'cliente') + (p ? '-' + p : '');
  }

  function exportPDF() {
    if (!lastReport) { toast('Gere um relatório primeiro.', 'err'); return; }
    // Print the current page — the @media print CSS hides all chrome and shows only .report.
    toast('Abrindo impressão — escolha “Salvar como PDF”.');
    setTimeout(function () { try { window.print(); } catch (e) { toast('Não consegui abrir a impressão.', 'err'); } }, 150);
  }

  function exportHTML() {
    if (!lastReport) { toast('Gere um relatório primeiro.', 'err'); return; }
    var doc = standaloneHTML(lastReport);
    var blob = new Blob([doc], { type: 'text/html;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = fileBase() + '.html';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1500);
    toast('Arquivo HTML baixado.');
  }

  function standaloneHTML(r) {
    var inner = buildReportHTML(r);
    return '<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8">' +
      '<meta name="viewport" content="width=device-width,initial-scale=1">' +
      '<title>' + esc(fileBase()) + '</title><style>' + REPORT_CSS + '</style></head>' +
      '<body><div class="report"><div class="report-inner">' + inner + '</div></div></body></html>';
  }

  function copyText() {
    if (!lastReport) { toast('Gere um relatório primeiro.', 'err'); return; }
    var b = lastReport.brief, d = lastReport.data, L = [];
    L.push('RELATÓRIO DE RESULTADOS — ' + b.cliente);
    L.push(b.periodo + ' · ' + b.canal + (b.preparado ? ' · Preparado por ' + b.preparado : ''));
    L.push('');
    // KPIs
    if (has(b.segFim) || has(b.segIni)) L.push('Seguidores: ' + fmtInt(has(b.segFim) ? b.segFim : b.segIni) + (has(b.growth) ? ' (' + fmtSigned(b.growth) + (has(b.growthPct) ? ', ' + (b.growthPct > 0 ? '+' : '') + fmtPct(b.growthPct) : '') + ')' : ''));
    if (has(b.alcance)) L.push('Alcance: ' + fmtInt(b.alcance) + (has(b.alcancePct) ? ' (' + (b.alcancePct > 0 ? '+' : '') + fmtPct(b.alcancePct) + ' vs. período anterior)' : ''));
    if (has(b.taxaEng)) L.push('Engajamento: ' + fmtPct(b.taxaEng) + ' (' + fmtInt(b.interacoes) + ' interações)');
    else if (has(b.interacoes)) L.push('Interações: ' + fmtInt(b.interacoes));
    if (has(b.pubTotal)) L.push('Publicações: ' + fmtInt(b.pubTotal) + (pubBreakdown(b) ? ' (' + pubBreakdown(b) + ')' : ''));
    if (has(b.leads)) L.push('Leads: ' + fmtInt(b.leads));
    if (has(b.vendas)) L.push('Vendas: ' + fmtInt(b.vendas));
    if (has(b.receita)) L.push('Receita: ' + fmtBRL(b.receita) + (has(b.roas) ? ' · ROAS ' + roasStr(b.roas) : ''));
    if (d.resumo) { L.push('\n## Resumo executivo'); L.push(d.resumo); }
    if (d.crescimento) { L.push('\n## Crescimento & alcance'); L.push(d.crescimento); }
    if (d.conteudo) { L.push('\n## Conteúdo & engajamento'); L.push(d.conteudo); }
    if (d.conversao) { L.push('\n## Conversão & resultados'); L.push(d.conversao); }
    if (b.topposts.length) { L.push('\n## Destaques de conteúdo'); b.topposts.forEach(function (t) { L.push('- ' + t.nome + (t.metric ? ' — ' + t.metric : '')); }); }
    if (d.destaques.length) { L.push('\n## Destaques do período'); d.destaques.forEach(function (x) { L.push('- ' + x); }); }
    if (d.recomendacoes.length) { L.push('\n## Próximos passos'); d.recomendacoes.forEach(function (x) { L.push('- ' + x); }); }
    L.push('\n— Gerado com Relatório IA · Maestros da IA');
    var text = L.join('\n');
    var done = function () { toast('Texto copiado.'); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(function () { fallbackCopy(text, done); });
    } else { fallbackCopy(text, done); }
  }
  function fallbackCopy(text, done) {
    var ta = document.createElement('textarea'); ta.value = text;
    ta.style.cssText = 'position:fixed;left:-9999px'; document.body.appendChild(ta);
    ta.select(); try { document.execCommand('copy'); done(); } catch (e) { toast('Não consegui copiar.', 'err'); }
    ta.remove();
  }

  // ---------- example / clear ----------
  function fillExample() {
    var set = function (id, v) { var el = $(id); if (el) el.value = v; };
    set('f-cliente', 'Padaria Pão & Cia');
    set('f-periodo', 'Setembro de 2026');
    set('f-canal', 'Instagram');
    set('f-preparado', 'Ana Souza · Studio ADS');
    set('f-segmento', 'Alimentação / padaria de bairro');
    set('f-seg-ini', '4200'); set('f-seg-fim', '5130');
    set('f-alcance', '86000'); set('f-alcance-ant', '61000');
    set('f-serie', '61000, 68000, 74000, 86000');
    set('f-serie-labels', 'Sem 1, Sem 2, Sem 3, Sem 4');
    set('f-curtidas', '3120'); set('f-comentarios', '410'); set('f-compart', '280'); set('f-salvos', '520');
    set('f-posts', '9'); set('f-reels', '12'); set('f-stories', '46');
    set('f-toppost', 'Reel “receita do pão de queijo” | 42 mil de alcance\nPost promoção do café da manhã | 380 curtidas');
    set('f-visitas', '1900'); set('f-leads', '240'); set('f-vendas', '58');
    set('f-invest', '600'); set('f-receita', '4350');
    set('f-destaques', 'Reel de receita viralizou; parceria com influenciadora local trouxe seguidores qualificados.');
    set('f-obs', 'Publicamos 3x mais Reels que no mês anterior e testamos anúncio de tráfego pela primeira vez. Feriado no meio do mês.');
    set('f-tom', 'profissional');
    toast('Exemplo preenchido. Clique em Gerar relatório.');
  }
  function clearForm() {
    ['f-cliente', 'f-periodo', 'f-preparado', 'f-segmento', 'f-seg-ini', 'f-seg-fim', 'f-alcance',
      'f-alcance-ant', 'f-serie', 'f-serie-labels', 'f-curtidas', 'f-comentarios', 'f-compart', 'f-salvos',
      'f-posts', 'f-reels', 'f-stories', 'f-toppost', 'f-visitas', 'f-leads', 'f-vendas', 'f-invest',
      'f-receita', 'f-destaques', 'f-obs'].forEach(function (id) { var el = $(id); if (el) el.value = ''; });
    $('f-canal').value = 'Instagram'; $('f-tom').value = 'profissional';
    $('f-cliente').focus();
    toast('Formulário limpo.');
  }

  // ---------- wire ----------
  function wire() {
    if (wired) return;
    var app = $('app-screen');
    if (!app || !app.classList.contains('active')) return;
    wired = true;

    if (window.ApiKeyManager && ApiKeyManager.renderModelPicker) ApiKeyManager.renderModelPicker('model-select'); // COR-047 (no-op: no studio select here)

    $('btn-generate').addEventListener('click', generate);
    $('btn-example').addEventListener('click', fillExample);
    $('btn-clear').addEventListener('click', clearForm);
    $('btn-pdf').addEventListener('click', exportPDF);
    $('btn-html').addEventListener('click', exportHTML);
    $('btn-copy').addEventListener('click', copyText);
    var okl = $('open-keys-link');
    if (okl) okl.addEventListener('click', function (e) { e.preventDefault(); var btn = $('manage-keys-btn'); if (btn) btn.click(); });

    syncKeyState();
  }

  function init() {
    window.addEventListener('maestria:app-ready', function () { wire(); syncKeyState(); });
    var app = $('app-screen');
    if (app) {
      var obs = new MutationObserver(function () {   // COR-044
        if (app.classList.contains('active')) { wire(); syncKeyState(); }
      });
      obs.observe(app, { attributes: true, attributeFilter: ['class'] });
    }
    if (app && app.classList.contains('active')) { wire(); syncKeyState(); }
  }

  // Compact self-contained CSS for the downloadable HTML report (mirrors styles.css report block)
  var REPORT_CSS =
    ':root{--sheet:#fff;--ink:#141b2d;--ink-2:#47536a;--ink-3:#7e8aa0;--line:#e2e6ec;--steel:#34506f;--gold:#b0894f;--gold-soft:#e9dcc3;--pos:#12915a;--pos-soft:#e2f2ea;--neg:#c33b3b;--neg-soft:#f8e5e5;--mono:ui-monospace,Menlo,Consolas,monospace;--serif:Georgia,"Times New Roman",serif}' +
    '*{box-sizing:border-box}body{margin:0;background:#eceef2;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;color:var(--ink);line-height:1.55;padding:24px}' +
    '.report{max-width:860px;margin:0 auto;background:#fff;border:1px solid var(--line);border-radius:12px;overflow:hidden}.report-inner{padding:40px 44px 48px}' +
    '.rp-cover{border:1.5px solid var(--gold);border-radius:10px;padding:26px 28px;position:relative;background:linear-gradient(180deg,#fdfbf6,#fff);margin-bottom:30px}' +
    '.rp-cover::after{content:"";position:absolute;inset:6px;border:1px solid var(--gold-soft);border-radius:7px;pointer-events:none}' +
    '.rp-seal{position:absolute;top:22px;right:26px;width:46px;height:46px}' +
    '.rp-kicker{font-family:var(--mono);font-size:11px;letter-spacing:.18em;text-transform:uppercase;color:var(--gold);font-weight:700}' +
    '.rp-client{font-family:var(--serif);font-size:30px;font-weight:700;margin:8px 0 4px;line-height:1.15}' +
    '.rp-period{font-size:15px;color:var(--steel);font-weight:650}.rp-prepared{margin-top:14px;font-size:12.5px;color:var(--ink-3);display:flex;flex-wrap:wrap;gap:4px 18px}.rp-prepared b{color:var(--ink-2)}' +
    '.rp-h{font-family:var(--serif);font-size:19px;font-weight:700;margin:34px 0 6px;padding-bottom:8px;border-bottom:1px solid var(--gold-soft);display:flex;align-items:baseline;gap:10px}' +
    '.rp-h-num{font-family:var(--mono);font-size:12px;color:var(--gold);font-weight:700}.rp-section:first-of-type .rp-h{margin-top:8px}' +
    '.rp-p{font-size:14.5px;line-height:1.7;color:var(--ink-2);margin:12px 0}.rp-p strong{color:var(--ink)}' +
    '.rp-kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin:18px 0 6px}' +
    '.kpi{background:#fbfcfe;border:1px solid var(--line);border-radius:10px;padding:14px 16px;border-top:3px solid var(--steel)}' +
    '.kpi-label{font-size:11px;letter-spacing:.05em;text-transform:uppercase;color:var(--ink-3);font-weight:700}' +
    '.kpi-value{font-family:var(--mono);font-variant-numeric:tabular-nums;font-size:27px;font-weight:700;margin:4px 0 2px;line-height:1.1}.kpi-sub{font-size:12px;color:var(--ink-3)}' +
    '.delta{display:inline-flex;align-items:center;gap:3px;font-family:var(--mono);font-size:12.5px;font-weight:700;padding:1px 7px;border-radius:999px}.delta.up{color:var(--pos);background:var(--pos-soft)}.delta.down{color:var(--neg);background:var(--neg-soft)}.delta.flat{color:var(--ink-3);background:#eef1f5}' +
    '.rp-charts{display:grid;grid-template-columns:1fr 1fr;gap:22px;margin:16px 0 6px}.rp-charts.one{grid-template-columns:1fr}.rp-charts>*{min-width:0}' +
    '.chart-card{background:#fff;border:1px solid var(--line);border-radius:10px;padding:16px 16px 12px}.chart-title{font-size:13px;font-weight:700;margin:0 0 2px}.chart-note{font-size:11.5px;color:var(--ink-3);margin:0 0 10px}.chart-card svg{width:100%;height:auto;display:block}' +
    '.rp-list{list-style:none;padding:0;margin:12px 0}.rp-list li{position:relative;padding:9px 0 9px 30px;border-bottom:1px solid var(--line);font-size:14px;color:var(--ink-2);line-height:1.55}.rp-list li:last-child{border-bottom:none}.rp-list li::before{content:"";position:absolute;left:4px;top:15px;width:8px;height:8px;background:var(--gold);border-radius:2px;transform:rotate(45deg)}.rp-list.checks li::before{background:var(--steel)}' +
    '.rp-table{width:100%;border-collapse:collapse;margin:12px 0;font-size:13.5px}.rp-table th,.rp-table td{text-align:left;padding:9px 10px;border-bottom:1px solid var(--line)}.rp-table th{font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:var(--ink-3);font-weight:700}.rp-table td.num,.rp-table th.num{text-align:right;font-family:var(--mono)}' +
    '.rp-foot{margin-top:36px;padding-top:16px;border-top:2px solid var(--gold-soft);display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;font-size:12px;color:var(--ink-3)}.rp-foot-brand{font-weight:700;color:var(--steel)}' +
    '@media(max-width:640px){.report-inner{padding:24px 18px}.rp-charts{grid-template-columns:1fr}.rp-client{font-size:24px}.rp-seal{display:none}}';

  return { init: init, syncKeyState: syncKeyState };
})();

window.App = App;
document.addEventListener('DOMContentLoaded', function () { App.init(); });
