'use strict';
const assert = require('node:assert/strict');
const P = require('../pult-core.js');
const defs=[{id:'ddt',name:'ДДТ'},{id:'g',name:'Гимназия'},{id:'jk',name:'JKids'},{id:'home',name:'Дом/Семья'}];
const now=new Date('2026-11-13T18:00:00Z');
let count=0;
function check(name,fn){fn();count++;console.log('✓ '+name);}
check('Часовой пояс Новосибирска',()=>assert.equal(P.todayISO(now),'2026-11-14'));
check('Старый плановый день не становится сроком или статусом',()=>{
 const old={id:'a',text:'Позвонить',zone:'ddt',day:'2026-11-15',done:false,_u:1};const before=JSON.stringify(old);
 const n=P.normalize(old,defs);assert.equal(n.due,P.UNKNOWN);assert.equal(n.status,P.UNKNOWN);assert.equal(n.scheduledFor,'2026-11-15');assert.equal(n.lastReviewed,P.UNKNOWN);assert(n.needsReview);assert.equal(JSON.stringify(old),before);
});
check('Сохраняется нестандартная сфера',()=>{const n=P.normalize({text:'Заехать',zone:'home'},defs);assert.equal(n.direction,P.UNKNOWN);assert.equal(n.zoneName,'Дом/Семья');});
check('Замороженный исходник не меняется при повторной расшифровке',()=>{const n=P.normalize({text:'Шаг',raw:'Повторная расшифровка',zone:'ddt',pult:{original:'Дословный исходник',direction:'JKids'}},defs);assert.equal(n.direction,'JKids');assert.equal(n.original,'Дословный исходник');});
check('Нет придуманных исполнителя, срока или статуса',()=>{const t=P.parse('JKids: отправить сценарий',defs,now);assert.equal(t.pult.assignee,P.UNKNOWN);assert.equal(t.pult.due,P.UNKNOWN);assert.equal(t.pult.status,P.UNKNOWN);assert.equal(t.day,null);assert.equal(t.zone,'jk');});
check('Дата без подписи не превращается в крайний срок',()=>{['JKids отправить сегодня','JKids отправить завтра','JKids отправить 18.11.2026','JKids отправить 2026-11-18'].forEach(s=>{const t=P.parse(s,defs,now);assert.equal(t.pult.due,P.UNKNOWN);assert.equal(t.day,null);assert(t.pult.needsReview);assert(t.pult.reason.includes('плановый день или крайний срок'));});});
check('Явные поля и относительная дата',()=>{const t=P.parse('Нужно отправить JKids; Проект: Старт; Срок: завтра; Ответственный: Анна; Статус: жду ответа; Приоритет: высокий',defs,now);assert.equal(t.pult.due,'2026-11-15');assert.equal(t.pult.assignee,'Анна');assert.equal(t.pult.status,'жду ответа');assert.equal(t.text,'отправить JKids');assert(!t.pult.needsReview);});
check('Несколько направлений требуют проверки',()=>{const t=P.parse('JKids и ДДТ: согласовать',defs,now);assert.equal(t.pult.direction,P.UNKNOWN);assert(t.pult.needsReview);});
check('Другая гимназия не становится гимназией 17',()=>{const t=P.parse('Гимназия 18: отправить',defs,now);assert.equal(t.pult.direction,P.UNKNOWN);assert(t.pult.needsReview);});
check('Сомнение в направлении не скрывается',()=>{const t=P.parse('Возможно JKids: отправить',defs,now);assert(t.pult.needsReview);});
check('Неверная дата не исправляется молча',()=>{const t=P.parse('JKids: отправить; Срок: 31.02.2026',defs,now);assert.equal(t.pult.due,P.UNKNOWN);assert(t.pult.needsReview);});
check('Повреждённая дата и дата без месяца требуют уточнения',()=>{['JKids отправить 2026-11-130','JKids отправить до 15-го'].forEach(s=>{const t=P.parse(s,defs,now);assert.equal(t.pult.due,P.UNKNOWN);assert(t.pult.needsReview);});});
check('Неоднозначный исполнитель и отрицание даты',()=>{const t=P.parse('JKids отправить не завтра; Ответственный: Анна или Иван',defs,now);assert.equal(t.pult.due,P.UNKNOWN);assert.equal(t.pult.assignee,P.UNKNOWN);assert(t.pult.needsReview);});
check('Все представления учитывают план и срок отдельно',()=>{
 const t=P.normalize({text:'Шаг',day:'2026-11-14',box:1,pult:{direction:'JKids',status:'жду ответа',due:'2026-11-17',needsReview:true}},defs);
 ['Входящие','Сегодня','Ближайшие','Жду','По направлениям','Требует внимания','Неразобранное'].forEach(v=>assert(P.matches(t,v,'2026-11-14'),v));assert(!P.matches(t,'Выполнено','2026-11-14'));
 const done=P.normalize({text:'Готово',done:true,box:1,pult:{status:'в работе'}},defs);assert(P.matches(done,'Выполнено'));assert(!P.matches(done,'Входящие'));assert(!P.matches(done,'Неразобранное'));
});
check('Импорт — чистый preview, повтор не создаёт дубли',()=>{
 const data={tasks:[{id:'remote',original:'Исходник',nextStep:'Отправить',direction:'JKids',project:'Пуск',priority:'высокий',due:'2026-11-16',status:'жду ответа',assignee:'Анна',dependency:'Ответ клиента',lastReviewed:P.UNKNOWN,inbox:true,needsReview:false,createdAt:'2026-11-12T12:00:00Z',updatedAt:'2026-11-13T12:00:00Z'}]};
 const s={tasks:[],zoneDefs:defs};const before=JSON.stringify(s);let preview=P.convertPultExport(JSON.stringify(data),s);assert.equal(JSON.stringify(s),before);assert.equal(preview.candidates.length,1);let t=preview.candidates[0];assert.equal(t.day,null);assert.equal(t.pult.due,'2026-11-16');assert.equal(t.raw,'Исходник');assert.equal(t.pult.status,'жду ответа');assert.equal(t.zone,'jk');
 s.tasks.push(t);preview=P.convertPultExport(data,s);assert.equal(preview.candidates.length,0);assert.equal(preview.skipped,1);
});
check('Повреждённый и чужой формат не импортируется',()=>{assert(P.convertPultExport('{',{}).issues.length);assert(P.convertPultExport({tasks:[{id:'legacy',text:'старый формат'}]},{}).issues.length);});
check('Повторный импорт не обещает восстановить удалённую задачу',()=>{const r=P.convertPultExport({tasks:[{id:'removed',original:'Исходник',nextStep:'Шаг'}]},{_tomb:{'pult-removed':1}});assert.equal(r.skipped,1);assert.equal(r.candidates.length,0);});
check('Журнал дополняет существующие записи',()=>{const state={pultLog:[{id:'old'}]};const log=P.appendLog(state,{taskId:'a',title:'Шаг',changes:'Статус: неизвестно → в работе'});assert.equal(state.pultLog.length,2);assert.equal(state.pultLog[0],log);assert.equal(state.pultLog[1].id,'old');assert(log.id);assert(log._u>0);assert(!isNaN(Date.parse(log.at)));});
console.log('Проверок пройдено: '+count);
