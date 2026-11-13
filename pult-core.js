(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.PultCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  var UNKNOWN = 'неизвестно';
  var DIRECTIONS = ['ДДТ им. В. Дубинина', 'Автомотоцентр', 'Гимназия 17', 'Медиаволонтёры', 'Келик', 'Фриланс', 'Видеопроизводство', 'JKids'];
  var STATUSES = ['входящие', 'сегодня', 'в работе', 'жду ответа', 'запланировано', 'выполнено', 'отложено', UNKNOWN];
  var PRIORITIES = [UNKNOWN, 'высокий', 'средний', 'низкий'];
  var VIEWS = ['Входящие', 'Сегодня', 'Ближайшие', 'Жду', 'По направлениям', 'Требует внимания', 'Выполнено', 'Неразобранное'];
  var patterns = [/ддт|дубинин/iu, /автомотоцентр/iu, /гимнази[яиюе]\s*(?:№\s*)?17(?!\d)/iu, /медиаволонт[её]р/iu, /кел[ие]к/iu, /фриланс/iu, /видеопроизводств/iu, /(?:\bjkids\b|джей\s*кидс)/iu];
  function text(value) { return typeof value === 'string' && value.trim() ? value : UNKNOWN; }
  function enumValue(value, options) { return options.indexOf(value) >= 0 ? value : UNKNOWN; }
  function todayISO(now) {
    var parts = new Intl.DateTimeFormat('en-CA', {timeZone:'Asia/Novosibirsk', year:'numeric', month:'2-digit', day:'2-digit'}).formatToParts(now || new Date());
    function get(k) { return parts.filter(function(p){return p.type === k;})[0].value; }
    return get('year') + '-' + get('month') + '-' + get('day');
  }
  function shiftDay(day, amount) { var d = new Date(day + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + amount); return d.toISOString().slice(0,10); }
  function validISO(value) {
    return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0,10) === value;
  }
  function dateValue(value, today) {
    var s = String(value || '').trim().toLowerCase().replace(/[.!]+$/, '');
    if (s === UNKNOWN) return UNKNOWN;
    if (s === 'сегодня') return today || todayISO();
    if (s === 'завтра') return shiftDay(today || todayISO(), 1);
    if (validISO(s)) return s;
    var m = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
    if (!m) return null;
    s = m[3] + '-' + m[2].padStart(2,'0') + '-' + m[1].padStart(2,'0');
    return validISO(s) ? s : null;
  }
  function matchingDirections(value) {
    return DIRECTIONS.filter(function(_,i){return patterns[i].test(String(value || ''));});
  }
  function directionForZone(zone, zoneDefs) {
    var def = (zoneDefs || []).filter(function(z){return z.id === zone;})[0];
    if (def && /^гимназия$/iu.test(String(def.name || '').trim())) return DIRECTIONS[2];
    var found = matchingDirections(def && def.name);
    return found.length === 1 ? found[0] : UNKNOWN;
  }
  function normalize(task, zoneDefs) {
    task = task || {};
    var p = task.pult && typeof task.pult === 'object' ? task.pult : {};
    var def = (zoneDefs || []).filter(function(z){return z.id === task.zone;})[0];
    var manualDirection = p.direction === UNKNOWN || DIRECTIONS.indexOf(p.direction) >= 0;
    var direction = manualDirection ? p.direction : directionForZone(task.zone, zoneDefs);
    var status = task.done ? 'выполнено' : enumValue(p.status, STATUSES);
    var confirmed = p.confirmed === true;
    var needsReview = typeof p.needsReview === 'boolean' ? p.needsReview : !confirmed;
    if (direction === UNKNOWN && !confirmed) needsReview = true;
    return {
      id: String(task.id || ''), original: text(p.original || task.raw || task.text), nextStep: text(task.text),
      direction: direction, zoneName: def ? text(def.name) : UNKNOWN, zone: task.zone || null,
      project: text(p.project), priority: enumValue(p.priority, PRIORITIES), due: validISO(p.due) ? p.due : UNKNOWN,
      scheduledFor: validISO(task.day) ? task.day : UNKNOWN,
      status: status, assignee: text(p.assignee), dependency: text(p.dependency),
      lastReviewed: typeof p.lastReviewed === 'string' && !isNaN(Date.parse(p.lastReviewed)) ? p.lastReviewed : UNKNOWN,
      createdAt: task.createdAt || UNKNOWN, updatedAt: task._u || UNKNOWN,
      confirmed: confirmed, needsReview: needsReview,
      reason: typeof p.reason === 'string' && p.reason ? p.reason : (needsReview ? (!task.pult ? 'Данные задачи ещё не проверены в Пульте' : 'Нужно проверить разбор задачи') : ''),
      inbox: !!task.box && status !== 'выполнено', main: !!task.main, cal: !!task.cal
    };
  }
  function parse(source, zoneDefs, now) {
    now = now || new Date();
    var original = String(source || ''), nextStep = original.trim(), fields = {}, reasons = [];
    var labels = /(?:^|[;\n]|\.\s+|\s+(?=(?:проект|приоритет|срок|статус|ответственный|исполнитель|зависимость|направление)\s*:))(проект|приоритет|срок|статус|ответственный|исполнитель|зависимость|направление)\s*:\s*([^;\n]*?)(?=(?:\.\s+|\s+)(?:проект|приоритет|срок|статус|ответственный|исполнитель|зависимость|направление)\s*:|[;\n]|$)/giu;
    var match;
    while ((match = labels.exec(original))) {
      var key = match[1].toLowerCase(); if (key === 'исполнитель') key = 'ответственный';
      (fields[key] || (fields[key] = [])).push(match[2].trim().replace(/[.]+$/, '').trim());
      nextStep = nextStep.replace(match[0], ' ');
    }
    function read(key) {
      var values = fields[key];
      if (!values) return UNKNOWN;
      if (values.length !== 1 || !values[0]) { reasons.push('Нужно уточнить поле «' + key + '»'); return UNKNOWN; }
      return values[0];
    }
    var scope = fields['направление'] ? read('направление') : nextStep;
    var found = matchingDirections(scope);
    var direction = found.length === 1 ? found[0] : UNKNOWN;
    if (found.length !== 1) reasons.push(found.length ? 'Упомянуты несколько направлений' : 'Направление не определено');
    if (found.length && /(?:возможно|кажется|наверное|\?)/iu.test(scope)) reasons.push('Принадлежность к направлению нужно подтвердить');
    var project = read('проект'), dependency = read('зависимость'), assignee = read('ответственный');
    if (/[?]|(?:^|\s)(?:или|возможно)(?:\s|$)/iu.test(assignee)) { assignee = UNKNOWN; reasons.push('Ответственный указан неоднозначно'); }
    var priority = read('приоритет').toLowerCase(), status = read('статус').toLowerCase();
    if (PRIORITIES.indexOf(priority) < 0) { priority = UNKNOWN; reasons.push('Нужно уточнить приоритет'); }
    if (STATUSES.indexOf(status) < 0) { status = UNKNOWN; reasons.push('Нужно уточнить статус'); }
    var due = UNKNOWN, rawDue = read('срок');
    if (fields['срок']) {
      var parsed = dateValue(rawDue, todayISO(now));
      if (parsed) due = parsed; else reasons.push('Срок неоднозначен или некорректен');
    } else {
      var dates = Array.from(nextStep.matchAll(/(?<!\d)\d{4}-\d{2}-\d{2}(?!\d)|(?<!\d)\d{1,2}\.\d{1,2}\.\d{4}(?!\d)|(?<![а-яё])(?:сегодня|завтра)(?![а-яё])/giu));
      if (dates.length) reasons.push('Уточните: плановый день или крайний срок');
      else if (/(?:срок|(?:к|до|в)\s+(?:понедельник|вторник|сред[уы]|четверг|пятниц[уы]|суббот[уы]|воскресень)|неделе|послезавтра|\d{4}-\d{2}-\d{2}|\d{1,2}\.\d{1,2}|\d{1,2}-го|\d{1,2}\s+(?:января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря))/iu.test(nextStep)) reasons.push('Срок требует уточнения');
    }
    nextStep = nextStep.replace(/^\s*(?:нужно|надо|необходимо)\s+/iu,'').replace(/^[\s.;:]+|[\s;]+$/g,'').replace(/\s+/g,' ');
    if (!nextStep) { nextStep = UNKNOWN; reasons.push('Не указан следующий шаг'); }
    var zones = (zoneDefs || []).filter(function(z){return direction !== UNKNOWN && directionForZone(z.id,zoneDefs) === direction;});
    var zone = zones.length === 1 ? zones[0].id : null;
    if (zones.length > 1) reasons.push('Для направления найдено несколько сфер — выберите вручную');
    return {text: nextStep, zone:zone, day:null, box:1, done: status === 'выполнено', pult:{
      original:original, direction:direction, project:project, priority:priority, due:due, status:status,
      assignee:assignee, dependency:dependency, lastReviewed:UNKNOWN, confirmed:false,
      needsReview:reasons.length > 0, reason:reasons.join('. ')
    }};
  }
  function matches(task, view, today) {
    today = today || todayISO();
    var completed = task.status === 'выполнено';
    function upcoming(v) { return validISO(v) && v >= today && v <= shiftDay(today,7); }
    switch (view) {
      case 'Выполнено': return completed;
      case 'Входящие': return !completed && task.inbox;
      case 'Сегодня': return !completed && (task.scheduledFor === today || task.due === today || task.status === 'сегодня');
      case 'Ближайшие': return !completed && (upcoming(task.scheduledFor) || upcoming(task.due));
      case 'Жду': return !completed && task.status === 'жду ответа';
      case 'Неразобранное': return !completed && task.needsReview;
      case 'Требует внимания': return !completed && (task.needsReview || task.priority === 'высокий' || (validISO(task.due) && task.due < today) || (validISO(task.scheduledFor) && task.scheduledFor < today) || task.lastReviewed === UNKNOWN || (typeof task.lastReviewed === 'string' && task.lastReviewed.slice(0,10) < shiftDay(today,-7)));
      case 'По направлениям': return !completed;
      default: return false;
    }
  }
  function appendLog(state, entry) {
    if (!Array.isArray(state.pultLog)) state.pultLog = [];
    var timestamp = Date.now(), at = entry && entry.at && !isNaN(Date.parse(entry.at)) ? entry.at : new Date(timestamp).toISOString();
    var id = typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : 'log-' + timestamp + '-' + Math.random().toString(36).slice(2);
    var log = {id:id,_u:timestamp,at:at,taskId:String(entry.taskId || ''),title:String(entry.title || 'Изменение задачи'),changes:String(entry.changes || '')};
    state.pultLog.unshift(log);
    return log;
  }
  function stableHash(value) {
    var hash = 2166136261;
    for (var i=0;i<value.length;i++) { hash ^= value.charCodeAt(i); hash = Math.imul(hash,16777619); }
    return (hash >>> 0).toString(36);
  }
  function convertPultExport(json, state) {
    var data;
    try { data = typeof json === 'string' ? JSON.parse(json.replace(/^\uFEFF/,'')) : json; }
    catch (_) { return {candidates:[],skipped:0,issues:['Не удалось прочитать JSON-файл']}; }
    if (!data || !Array.isArray(data.tasks)) return {candidates:[],skipped:0,issues:['Не найден список задач Пульта']};
    state = state || {};
    var existing = {}, candidates = [], issues = [], skipped = 0, defs = state.zoneDefs || [];
    (state.tasks || []).forEach(function(t){existing[t.id] = true; if(t.pult && t.pult.importedFrom) existing['pult-' + t.pult.importedFrom] = true;});
    Object.keys(state._tomb || {}).forEach(function(id){existing[id] = true;});
    data.tasks.forEach(function(t,index){
      if (!t || typeof t.nextStep !== 'string' || !t.nextStep.trim() || typeof t.original !== 'string') { issues.push('Запись ' + (index+1) + ': это не задача из выгрузки Пульта'); return; }
      var sourceId = typeof t.id === 'string' && t.id ? t.id : stableHash(t.original + '\n' + t.nextStep);
      var id = 'pult-' + sourceId;
      if (existing[id]) { skipped++; return; }
      existing[id] = true;
      var direction = enumValue(t.direction, DIRECTIONS), due = validISO(t.due) ? t.due : UNKNOWN;
      var reasons = typeof t.reason === 'string' && t.reason ? [t.reason] : [];
      if (direction === UNKNOWN) reasons.push('Направление требует проверки');
      if (t.due && t.due !== UNKNOWN && due === UNKNOWN) reasons.push('Не удалось перенести некорректный срок');
      if (t.status && STATUSES.indexOf(t.status) < 0) reasons.push('Статус требует проверки');
      if (t.priority && PRIORITIES.indexOf(t.priority) < 0) reasons.push('Приоритет требует проверки');
      if (t.scheduledFor && t.scheduledFor !== UNKNOWN && !validISO(t.scheduledFor)) reasons.push('Плановый день требует проверки');
      if (t.lastReviewed && t.lastReviewed !== UNKNOWN && isNaN(Date.parse(t.lastReviewed))) reasons.push('Дата последней проверки требует уточнения');
      var zones = defs.filter(function(z){return direction !== UNKNOWN && directionForZone(z.id,defs) === direction;});
      if (zones.length > 1) reasons.push('Выберите сферу вручную');
      var status = enumValue(t.status,STATUSES);
      var task = {id:id,text:t.nextStep,raw:t.original,zone:zones.length === 1 ? zones[0].id : null,
        day:validISO(t.scheduledFor) ? t.scheduledFor : null,box:t.inbox === false ? 0 : 1,done:status === 'выполнено',
        createdAt:!isNaN(Date.parse(t.createdAt)) ? Date.parse(t.createdAt) : 0,_u:!isNaN(Date.parse(t.updatedAt)) ? Date.parse(t.updatedAt) : 0,
        pult:{original:t.original,direction:direction,project:text(t.project),priority:enumValue(t.priority,PRIORITIES),due:due,status:status,
          assignee:text(t.assignee),dependency:text(t.dependency),lastReviewed:typeof t.lastReviewed === 'string' && !isNaN(Date.parse(t.lastReviewed)) ? t.lastReviewed : UNKNOWN,
          needsReview:t.needsReview === true || reasons.length > 0,reason:reasons.join('. '),confirmed:t.inbox === false && !t.needsReview && !reasons.length,importedFrom:sourceId}};
      if (!task.zone && !task.day && !task.done) task.box = 1;
      candidates.push(task);
    });
    return {candidates:candidates,skipped:skipped,issues:issues};
  }
  return {UNKNOWN:UNKNOWN,DIRECTIONS:DIRECTIONS,STATUSES:STATUSES,PRIORITIES:PRIORITIES,VIEWS:VIEWS,todayISO:todayISO,dateValue:dateValue,directionForZone:directionForZone,normalize:normalize,parse:parse,matches:matches,appendLog:appendLog,convertPultExport:convertPultExport};
});
