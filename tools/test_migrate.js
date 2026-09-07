/* Проверка переезда старых списков в общий (migrateTasks) вместе со слиянием.
 *
 *     node tools/test_migrate.js
 *
 * Код берётся из index.html как есть: блок слияния (MERGE) и сама migrateTasks.
 * Здесь ловится то, чего не видит test_merge.js: как ведёт себя ежедневник, когда
 * рядом живёт устройство со СТАРЫМИ списками (today/inbox/zones/weekTasks) —
 * ровно то, из-за чего в «Задачах на сегодня» появлялись записи годовой давности.
 */
var fs = require('fs');
var vm = require('vm');

var html = fs.readFileSync(__dirname + '/../index.html', 'utf8');
function cut(from, to) {
  var a = html.indexOf(from), b = html.indexOf(to, a);
  if (a < 0 || b < 0) { console.error('не нашёл кусок: ' + from); process.exit(1); }
  return html.slice(a, b);
}
var code = cut('/* --- MERGE-BEGIN', '/* --- MERGE-END')
         + cut('function migrateTasks(s){', '\nfunction patchState(');

var ctx = {
  S: {}, Date: Date, Array: Array, Math: Math, JSON: JSON, Object: Object, String: String, console: console,
  localStorage: { getItem: function () { return null; }, setItem: function () {} }
};
ctx.dateKey = function (d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
};
ctx.todayStr = function () { return ctx.dateKey(new Date()); };
vm.createContext(ctx);
vm.runInContext(code, ctx);

var fails = 0, checks = 0;
function ok(name, cond, extra) {
  checks++;
  if (cond) { console.log('  ok   ' + name); }
  else { fails++; console.log('  ПЛОХО ' + name + (extra ? '\n        ' + extra : '')); }
}
function has(list, text) { return (list || []).some(function (t) { return t && t.text === text; }); }
function find(list, text) { return (list || []).filter(function (t) { return t && t.text === text; }); }

var HOUR = 3600000, DAY = 24 * HOUR, NOW = Date.now();
var TODAY = ctx.todayStr();
var LONG_AGO = ctx.dateKey(new Date(NOW - 200 * DAY));

/* Ежедневник в старом виде: дела лежат по отдельным спискам. */
function oldStyle(stamp) {
  return {
    today: [], inbox: [], reminders: [], archive: [], zones: {}, zoneOrder: [],
    weekTasks: {}, mainTask: {}, calendar: {}, _tomb: {}, _updatedAt: stamp, date: LONG_AGO
  };
}

console.log('\n1. Старый список «Сегодня» не делает древние дела сегодняшними');
(function () {
  var s = oldStyle(NOW - 200 * DAY);
  s.today = [{ id: 'old1', text: 'дело из марта', done: false, _u: NOW - 200 * DAY }];
  ctx.migrateTasks(s);
  var t = find(s.tasks, 'дело из марта')[0];
  ok('запись не потерялась', !!t);
  ok('не встала на сегодня', !t || t.day !== TODAY, t && ('день=' + t.day));
  ok('лежит во «Входящих», ждёт разбора', !t || t.box === 1, t && ('box=' + t.box));
})();

console.log('\n2. Сегодняшнее из старого списка остаётся сегодняшним');
(function () {
  var s = oldStyle(NOW);
  s.date = TODAY;
  s.today = [{ id: 'n1', text: 'сегодняшнее дело', done: false, _u: NOW }];
  ctx.migrateTasks(s);
  var t = find(s.tasks, 'сегодняшнее дело')[0];
  ok('день сегодняшний', !!t && t.day === TODAY, t && ('день=' + t.day));
})();

console.log('\n3. Удалённое не воскресает через старые списки');
(function () {
  var s = oldStyle(NOW);
  s.date = TODAY;
  // Дело удалили вчера — надгробие есть, а на втором устройстве оно ещё лежит
  // в старом списке и приезжает вместе со слиянием.
  s._tomb = { z9: NOW - DAY };
  s.zones = { ddt: { tasks: [{ id: 'z9', text: 'удалённое дело', done: false, _u: NOW - 3 * DAY }] } };
  s.today = [{ id: 't9', text: 'удалённое дело дня', done: false, _u: NOW - 3 * DAY }];
  s._tomb.t9 = NOW - DAY;
  ctx.migrateTasks(s);
  ok('удалённое из сферы не вернулось', !has(s.tasks, 'удалённое дело'), JSON.stringify(s.tasks.map(function (t) { return t.text; })));
  ok('удалённое из «Сегодня» не вернулось', !has(s.tasks, 'удалённое дело дня'));
})();

console.log('\n4. Переезд можно повторять: дубликатов нет');
(function () {
  var s = oldStyle(NOW);
  s.date = TODAY;
  s.inbox = [{ id: 'i1', text: 'позвонить в гимназию', _u: NOW }];
  ctx.migrateTasks(s);
  var once = s.tasks.length;
  s.inbox = [{ id: 'i1', text: 'позвонить в гимназию', _u: NOW }];   // приехало снова
  ctx.migrateTasks(s);
  ok('второй переезд ничего не добавил', s.tasks.length === once, 'было ' + once + ', стало ' + s.tasks.length);
  ok('запись одна', find(s.tasks, 'позвонить в гимназию').length === 1);
})();

console.log('\n5. Записи без штампа времени не воскресают после удаления');
(function () {
  // Телефон: дело удалили час назад. Компьютер: то же дело лежит без _u
  // (запись сделана до того, как появились штампы), сохранён компьютер позже.
  var phone = { tasks: [], _tomb: { x1: NOW - HOUR }, _updatedAt: NOW - HOUR, zones: {}, today: [], inbox: [] };
  var pc = { tasks: [{ id: 'x1', text: 'дело без штампа' }], _tomb: {}, _updatedAt: NOW, zones: {}, today: [], inbox: [] };
  var m = ctx.ezMergeStates(phone, pc, NOW);
  ok('удалённое не вернулось', !has(m.tasks, 'дело без штампа'), JSON.stringify(m.tasks));
})();

console.log('\n6. Живое дело без штампа никуда не пропадает');
(function () {
  var phone = { tasks: [], _tomb: {}, _updatedAt: NOW - HOUR, zones: {}, today: [], inbox: [] };
  var pc = { tasks: [{ id: 'y1', text: 'дело без штампа' }], _tomb: {}, _updatedAt: NOW, zones: {}, today: [], inbox: [] };
  var m = ctx.ezMergeStates(phone, pc, NOW);
  ok('дело на месте', has(m.tasks, 'дело без штампа'));
})();

console.log('\n7. Главная задача дня переезжает один раз');
(function () {
  var s = oldStyle(NOW);
  s.date = TODAY;
  s.mainTask = {}; s.mainTask[TODAY] = { text: 'сдать модель', done: false, _u: NOW };
  ctx.migrateTasks(s);
  ctx.migrateTasks(s);
  ok('одна запись, не две', find(s.tasks, 'сдать модель').length === 1);
  ok('со звездой и на своём дне', find(s.tasks, 'сдать модель')[0].main === 1 && find(s.tasks, 'сдать модель')[0].day === TODAY);
})();

console.log('\n' + (fails ? '✗ ПРОВАЛЕНО ' + fails + ' из ' + checks : '✓ Все ' + checks + ' проверок прошли'));
process.exit(fails ? 1 : 0);
