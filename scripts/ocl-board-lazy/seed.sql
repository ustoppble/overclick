\set ON_ERROR_STOP on
insert into workspace(name) values ('perf');
create temp table ws as select id from workspace limit 1;
insert into organization(workspace_id,name) select (select id from ws), 'org'||g from generate_series(1,8) g;
insert into "user"(email, role, organization_id) values ('admin@perf.test','admin',null);
insert into "user"(email, role, organization_id) select 'member@perf.test','member',(select id from organization order by name limit 1);
insert into project(workspace_id,name,id_prefix,organization_id)
 select (select id from ws),'proj'||g,'P'||lpad(g::text,3,'0'),(select id from organization order by id offset (g%8) limit 1) from generate_series(1,77) g;
insert into mission(workspace_id,title,organization_id)
 select (select id from ws),'mission '||g,(select id from organization order by id offset (g%8) limit 1) from generate_series(1,139) g;
insert into mcp_token(workspace_id,label,hash,owner_user_id) select (select id from ws),'t'||g,md5(g::text),(select id from "user" order by email limit 1) from generate_series(1,40) g;
-- member linked to 27 projects of its org... (27 links, as prod)
insert into project_member(project_id,user_id) select p.id,(select id from "user" where role='member') from project p order by p.id limit 27;
-- 3595 tasks; age skewed like prod: 16 in 7d, 83 in 30d, rest spread to 200 days
create temp table seq as select g, row_number() over () rn from generate_series(1,3595) g;
insert into task(project_id,mission_id,short_id,title,o_que,por_que,como_confirmo,tipo,status,priority,created_at,updated_at,claimed_by_token_id,created_by_user_id,previous_short_ids)
select (select id from project order by id offset (g%77) limit 1),
       case when g%5=0 then null else (select id from mission order by id offset (g%139) limit 1) end,
       'P'||lpad(((g%77)+1)::text,3,'0')||'-'||g,
       'Card number '||g||' '||repeat('título do card ',3),
       repeat('Contrato: o que fazer neste card, com detalhes de arquivos e comportamentos esperados. ',12),
       repeat('Por que importa: contexto de negócio e riscos. ',6),
       repeat('Como confirmo: rodar testes e conferir saída. ',6),
       (array['feature','bug','rfc','feature'])[1+g%4]::task_type,
       (case when g%100<75 then 'feito' when g%100<93 then 'aberto' when g%100<97 then 'em_execucao' else 'descartado' end)::task_status,
       (array['baixa','media','alta','urgente'])[1+g%4]::task_priority,
       now() - ((case when g<=16 then random()*6 when g<=83 then 7+random()*22 else 30+random()*170 end)||' days')::interval - interval '2 days',
       now() - ((case when g<=16 then random()*6 when g<=83 then 7+random()*22 else 30+random()*170 end)||' days')::interval,
       (select id from mcp_token order by id offset (g%40) limit 1),
       (select id from "user" order by email limit 1),
       '[]'::jsonb
from generate_series(1,3595) g;
update task set created_at = updated_at - interval '1 day' where created_at > updated_at;
insert into execution_attempt(task_id,executor,model,started_at,last_activity_at,finished_at,tokens_in,tokens_out,tokens_cache,cost_usd)
select id,'claude','claude-sonnet-5-5',updated_at-interval '1 hour',updated_at,updated_at,100000,20000,500000,1.5 from (select id,updated_at from task order by random() limit 3159) t;
insert into handoff(task_id,summary,created_at)
select id,repeat('Resumo da entrega com evidências. ',20),updated_at from (select id,updated_at from task order by random() limit 2773) t;
insert into task_comment(task_id,body,created_at) select id, repeat('comentário ',40), updated_at from (select id,updated_at from task order by random() limit 4842) t;
analyze;
select (select count(*) from task) t,(select count(*) from execution_attempt) a,(select count(*) from handoff) h,(select count(*) from task_comment) c;
