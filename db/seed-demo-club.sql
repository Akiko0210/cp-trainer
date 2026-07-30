-- Demo club, for looking at a populated leaderboard before real members join.
-- Uses real public Codeforces handles so a later sync produces real data.
--
-- Remove it all with:
--   delete from users where github_id between 900001 and 900006;
--   delete from groups where slug = 'sjsu-cp';   -- keep the group, drop members
--
-- (group_members and submissions cascade from users.)

insert into users
  (github_id, github_login, display_name, avatar_url, cf_handle, cf_rating, cf_rank)
values
  (900001,'mira-k','Mira Kapoor','https://avatars.githubusercontent.com/u/1?v=4','Radewoosh',2100,'master'),
  (900002,'devon-l','Devon Liu','https://avatars.githubusercontent.com/u/2?v=4','Um_nik',1950,'candidate master'),
  (900003,'aisha-r','Aisha Rahman',null,'kefaa2',1720,'expert'),
  (900004,'tomas-b','Tomas Bianchi','https://avatars.githubusercontent.com/u/4?v=4','SecondThread',1610,'specialist'),
  (900005,'yuki-n','Yuki Nakamura',null,'dorijanlendvaj',1480,'specialist'),
  (900006,'sam-o','Sam Osei','https://avatars.githubusercontent.com/u/6?v=4',null,null,null)
on conflict (github_id) do nothing;

insert into groups (slug, name, description, invite_code, created_by)
values ('sjsu-cp', 'SJSU Competitive Programming',
        'San Jose State University ICPC club - NAC bound.', 'SJSU2026',
        (select id from users where github_id is null order by id limit 1))
on conflict (slug) do nothing;

-- Whoever owns the local account owns the club.
insert into group_members (group_id, user_id, role)
select g.id, u.id, 'owner'
from groups g, users u
where g.slug = 'sjsu-cp' and u.github_id is null
order by u.id limit 1
on conflict do nothing;

insert into group_members (group_id, user_id, role)
select g.id, u.id, 'member' from groups g, users u
where g.slug = 'sjsu-cp' and u.github_id between 900001 and 900006
on conflict do nothing;

-- A little solve history so the streak and 30-day columns aren't blank.
do $$
declare uid bigint; pid bigint; n int;
begin
  for uid in select id from users where github_id between 900001 and 900005 loop
    n := 0;
    for pid in (select id from problem_catalog
                where source = 'cf' and rating is not null
                order by (id * uid) % 9973 limit 24) loop
      n := n + 1;
      insert into submissions
        (user_id, problem_id, verdict, submitted_at, source,
         external_submission_id, participant_type)
      values (uid, pid, 'OK',
              now() - (((n * 3 + (uid % 5)) % 26)::int) * interval '1 day',
              'cf_api', uid * 100000 + n, 'PRACTICE')
      on conflict do nothing;
    end loop;
  end loop;
end $$;
