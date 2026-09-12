insert into pricing.sources(slug,name,base_url)
values ('costco','Costco Pharmacy','https://rx.costco.com')
on conflict(slug) do update set name=excluded.name,base_url=excluded.base_url,enabled=true;
