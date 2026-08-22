/* Проверка слияния двух ежедневников.  Запуск из корня репозитория:
 *
 *     node tools/test_merge.js
 *
 * Тест берёт НАСТОЯЩИЙ код из index.html (кусок между MERGE-BEGIN и MERGE-END),
 * а не его копию — значит, правка в приложении проверяется здесь же.
 *
 * Проверяем главное обещание: что бы ни случилось со связью, задача, которую
 * человек записал, не должна исчезнуть при следующей синхронизации.
 */
var fs = require('fs');
var vm = require('vm');

var html = fs.readFileSync(__dirname + '/../index.html', 'utf8');
var a = html.indexOf('/* --- MERGE-BEGIN');
var b = html.indexOf('/* --- MERGE-END');
if (a < 0 || b < 0) { console.error('Не нашёл блок MERGE в index.html'); process.exit(1); }
var code = html.slice(a, b);

var ctx = { S: {}, Date: Date, Array: Array, Math: Math, JSON: JSON, console: console };
vm.createContext(ctx);
vm.runInContext(code, ctx);

var fails = 0, checks = 0;
function ok(name, cond, extra) {
  checks++;
  if (cond) { console.log('  ok   ' + name); }
  else { fails++; console.log('  ПЛОХО ' + name + (extra ? '\n        ' + extra : '')); }
}
function has(list, text) { return (list || []).some(function (t) { return t && t.text === text; }); }
function task(id, text, stamp, done) { return { id: id, text: text, done: !!done, _u: stamp }; }

var HOUR = 3600000, NOW = Date.now();
var T9 = NOW - 12 * HOUR, T13 = NOW - 8 * HOUR, T20 = NOW - HOUR;

/* Базовый ежедневник, с которого разошлись оба устройства. */
function base(stamp) {
  return {
    today: [task('t1', 'старая задача', T9)],
    inbox: [], reminders: [], archive: [],
    zones: { ddt: { tasks: [task('z1', 'зона: снять выезд', T9)] } },
    zoneOrder: ['ddt'], weekTasks: {}, mainTask: {}, calendar: {},
    date: '2026-08-22', _tomb: {}, _updatedAt: stamp
  };
}

console.log('\n1. Метро: правка на телефоне и правка на компьютере складываются');
(function () {
  var phone = base(T20);                                     // офлайн с утра, отдал вечером
  phone.inbox.push(task('p1', 'позвонить в гимназию', T9));
  var pc = base(T13);                                        // компьютер отдал днём
  pc.inbox.push(task('c1', 'смонтировать ролик', T13));

  var m = ctx.ezMergeStates(phone, pc, NOW);
  ok('задача с телефона на месте', has(m.inbox, 'позвонить в гимназию'));
  ok('задача с компьютера на месте', has(m.inbox, 'смонтировать ролик'), JSON.stringify(m.inbox));
  ok('старое никуда не делось', has(m.today, 'старая задача'));

  var m2 = ctx.ezMergeStates(pc, phone, NOW);                // порядок не важен
  ok('порядок устройств не решает', m2.inbox.length === m.inbox.length);
})();

console.log('\n2. Удалённое не воскресает');
(function () {
  var phone = base(T20);
  phone.zones.ddt.tasks = [];                                // удалил на телефоне в 13:00
  phone._tomb = { z1: T13 };
  var pc = base(T20 + 1000);                                 // компьютер сохранился позже, задача у него ещё есть
  var m = ctx.ezMergeStates(phone, pc, NOW);
  ok('удалённая задача не вернулась', m.zones.ddt.tasks.length === 0, JSON.stringify(m.zones.ddt.tasks));
})();

console.log('\n3. Удалили, но потом дописали заново — новая запись живёт');
(function () {
  var phone = base(T20);
  phone._tomb = { z1: T13 };
  phone.zones.ddt.tasks = [task('z9', 'снять выезд ещё раз', T20)];
  var pc = base(T13);
  var m = ctx.ezMergeStates(phone, pc, NOW);
  ok('новая запись на месте', has(m.zones.ddt.tasks, 'снять выезд ещё раз'));
  ok('старая осталась удалённой', !has(m.zones.ddt.tasks, 'зона: снять выезд'));
})();

console.log('\n4. Галочку ставит тот, кто трогал задачу позже');
(function () {
  var phone = base(T20);
  phone.today = [task('t1', 'старая задача', T13, true)];    // отметил в 13:00
  var pc = base(T20 + 5000);                                 // компьютер сохранялся позже, но задачу не трогал
  pc.today = [task('t1', 'старая задача', T9, false)];
  var m = ctx.ezMergeStates(phone, pc, NOW);
  ok('галочка сохранилась', m.today[0].done === true);
})();

console.log('\n5. Планирование на день и главная задача');
(function () {
  var phone = base(T20);
  phone.weekTasks['2026-08-25'] = [task('w1', 'созвон с Келек', T20)];
  phone.mainTask['2026-08-22'] = { text: 'сдать модель', done: false, _u: T20 };
  var pc = base(T13);
  pc.weekTasks['2026-08-25'] = [task('w2', 'забрать документы', T13)];
  pc.mainTask['2026-08-22'] = { text: 'сдать модель', done: true, _u: T13 };
  var m = ctx.ezMergeStates(phone, pc, NOW);
  ok('обе задачи недели на месте', m.weekTasks['2026-08-25'].length === 2);
  ok('главная задача взята у того, кто трогал позже', m.mainTask['2026-08-22'].done === false);
})();

console.log('\n6. Заметка календаря: удалили — не возвращается, дописали — приезжает');
(function () {
  var phone = base(T20);
  phone.calendar['2026-09-01'] = 'линейка';
  var pc = base(T13);
  var m = ctx.ezMergeStates(phone, pc, NOW);
  ok('новая заметка приехала', m.calendar['2026-09-01'] === 'линейка');

  var phone2 = base(T20);
  phone2._tomb = { 'cal:2026-09-01': T20 };                  // удалил на телефоне
  var pc2 = base(T13);
  pc2.calendar['2026-09-01'] = 'линейка';
  var m2 = ctx.ezMergeStates(phone2, pc2, NOW);
  ok('удалённая заметка не вернулась', !m2.calendar['2026-09-01']);
})();

console.log('\n7. Слияние с самим собой ничего не меняет');
(function () {
  var s = base(T20);
  s.inbox.push(task('i1', 'купить краску', T13));
  s.weekTasks['2026-08-26'] = [task('w3', 'запись урока', T13)];
  s.calendar['2026-08-30'] = 'день рождения';
  var once = ctx.ezMergeStates(s, s, NOW);
  var twice = ctx.ezMergeStates(once, JSON.parse(JSON.stringify(once)), NOW);
  ok('второй проход не меняет ничего', JSON.stringify(once) === JSON.stringify(twice));
})();

console.log('\n8. Свежая установка не подмешивает свои примеры задач');
(function () {
  var fresh = base(0); delete fresh._updatedAt;
  ok('пустая копия распознаётся', ctx.ezIsUntouched(fresh) === true);
  ok('рабочая копия — нет', ctx.ezIsUntouched(base(T20)) === false);
})();

console.log('\n9. Сферы и расписание (то, что владелец правит сам)');
(function () {
  var phone = base(T20);
  phone.zoneDefs = [{ id: 'ddt', name: 'ДДТ', color: '#1D9E75', _u: T9 },
                    { id: 'new1', name: 'Новая работа', color: '#333', _u: T20 }];
  phone.schedule = { fixed: {}, free: {}, tags: {}, _u: T20 };
  var pc = base(T13);
  pc.zoneDefs = [{ id: 'ddt', name: 'ДДТ переименован', color: '#1D9E75', _u: T13 }];
  pc.schedule = { fixed: { 2: [{ t: '10:00', l: 'старое' }] }, free: {}, tags: {}, _u: T13 };
  var m = ctx.ezMergeStates(phone, pc, NOW);
  ok('новая сфера с телефона на месте', m.zoneDefs.length === 2);
  ok('переименование берётся у того, кто правил позже', m.zoneDefs.filter(function (z) { return z.id === 'ddt' })[0].name === 'ДДТ переименован');
  ok('расписание — версия, которую правили позже', !m.schedule.fixed[2]);
})();

console.log('\n10. Надгробия не копятся вечно');
(function () {
  var old = NOW - 90 * 24 * HOUR;
  var m = ctx.ezMergeTombs({ a: old }, { b: NOW - HOUR }, NOW);
  ok('старше 60 дней вычищено', !m.a && !!m.b);
})();

console.log('\n11. Примеры задач с новой установки не подмешиваются');
(function () {
  var fresh = base(T13);                                     // телефон, только что поставленный
  fresh.zones.ddt.tasks = [{ id: 's1', text: 'Не курить', done: false, _u: T13, _seed: 1 }];
  var real = base(T20);                                      // настоящий ежедневник
  var m = ctx.ezMergeStates(fresh, real, NOW);
  ok('пример не попал в рабочий список', !has(m.zones.ddt.tasks, 'Не курить'));
  ok('настоящая задача на месте', has(m.zones.ddt.tasks, 'зона: снять выезд'));
})();

console.log('\n12. Битые данные не роняют слияние');
(function () {
  var m = ctx.ezMergeStates(base(T20), { _updatedAt: T13 }, NOW);
  ok('половинчатая копия пережёвана', Array.isArray(m.today) && m.today.length === 1);
  var m2 = ctx.ezMergeStates(base(T20), null, NOW);
  ok('пустая копия не ломает', !!m2 && m2.today.length === 1);
})();

console.log('\n' + (fails ? '✗ ПРОВАЛЕНО ' + fails + ' из ' + checks : '✓ Все ' + checks + ' проверок прошли'));
process.exit(fails ? 1 : 0);
