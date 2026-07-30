-- Demo guild, for looking at a populated board before real members join.
--
-- The five linked members are real public Codeforces handles, so a sync
-- produces real submissions, real fits, and real per-area differences — the
-- champions grid is only worth looking at if the contest in it is genuine.
--
-- The handles are deliberately chosen near this account's own level (CF
-- 1650-1810). An earlier version used grandmasters, and the result was one
-- member holding all eight areas forever, which tells you nothing.
--
-- Remove it all with:
--   delete from users where github_id between 900001 and 900006;
--   delete from guilds where slug = 'sjsu-cp';   -- also empties the guild
--
-- (Submissions cascade from users; users.guild_id nulls out with the guild.)

insert into users
  (github_id, github_login, display_name, avatar_url, cf_handle, cf_rating, cf_rank)
values
  (900001,'mira-k','Mira Kapoor','https://avatars.githubusercontent.com/u/1?v=4','Prabudh_',1808,'expert'),
  (900002,'devon-l','Devon Liu','https://avatars.githubusercontent.com/u/2?v=4','RUS_MichailS',1790,'expert'),
  (900003,'aisha-r','Aisha Rahman',null,'hminhdepzai',1776,'expert'),
  (900004,'tomas-b','Tomas Bianchi','https://avatars.githubusercontent.com/u/4?v=4','djyqjy',1710,'expert'),
  (900005,'yuki-n','Yuki Nakamura',null,'mateuszmj',1655,'expert'),
  -- One member with no handle linked yet: that state is normal in a real club
  -- and the roster has to look right with it.
  (900006,'sam-o','Sam Osei','https://avatars.githubusercontent.com/u/6?v=4',null,null,null)
on conflict (github_id) do nothing;

insert into guilds (slug, name, tagline, invite_code, created_by)
values ('sjsu-cp', 'SJSU Competitive Programming',
        'San Jose State University ICPC club - NAC bound.', 'SJSU2026',
        (select id from users where coalesce(github_id, 0) < 900000
          order by id limit 1))
on conflict (slug) do nothing;

-- Whoever owns this install leads the guild.
update users set guild_id = (select id from guilds where slug = 'sjsu-cp'),
                 guild_role = 'leader',
                 guild_joined_at = now()
where id = (select id from users where coalesce(github_id, 0) < 900000
             order by id limit 1)
  and guild_id is null;

update users set guild_id = (select id from guilds where slug = 'sjsu-cp'),
                 guild_role = 'member',
                 guild_joined_at = now()
where github_id between 900001 and 900006 and guild_id is null;

-- The one fabricated part: a little recent activity, so the streak and 30-day
-- boards aren't a column of zeros. Real mirrored history decides the ability
-- and champion boards; these rows only affect recency. Ids sit in a 9xxxxxxx
-- range so they can never collide with a real Codeforces submission id.
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
              'cf_api', 90000000 + uid * 1000 + n, 'PRACTICE')
      on conflict do nothing;
    end loop;
  end loop;
end $$;
