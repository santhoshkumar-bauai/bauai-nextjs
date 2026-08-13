# Migration cohort — review & sign-off

Generated 2026-08-12T18:40:36.978Z from the legacy Supabase database.

**To approve:** review the tables below, move any misfiled company between
the include/exclude lists in `cohort.json`, then set `signedOffBy` in that
file to your name. Phases 3-7 refuse to run while it is null.

- **34** companies to migrate (64 users)
- **0** need a human decision
- **234** excluded of 268 total

## Include

| Company | Activity | Members | Signed in | Active ≤180d | Docs | Reason |
|---|---:|---:|---:|---:|---:|---|
| WIRL INGENIEURE GMBH | 740 | 1 | 1 | 1 | 1412 | active (740 signals) |
| BAU AI GmbH | 307 | 15 | 13 | 9 | 144 | active (307 signals) |
| Wirl Ingenieure GmbH | 211 | 2 | 1 | 1 | 211 | active (211 signals) |
| Graebert | 97 | 11 | 7 | 3 | 158 | active (97 signals) |
| Hansa Bauunternehmung GmbH | 93 | 2 | 2 | 1 | 119 | active (93 signals) |
| CARBOCON GMBH | 76 | 1 | 1 | 1 | 0 | active (76 signals) |
| Brueninghoff Group | 72 | 1 | 1 | 1 | 0 | active (72 signals) |
| seg architekten PartGmbB | 54 | 1 | 1 | 1 | 0 | active (54 signals) |
| ABMP Architektur und Generalplanung | 46 | 1 | 1 | 1 | 29 | active (46 signals) |
| hns-bau-gmbh.de | 15 | 2 | 2 | 2 | 0 | identified via duplicate "HNS Bau GmbH" |
| hansabauteam.de | 8 | 1 | 1 | 1 | 0 | real construction firm; signup named it after the email domain (override by Santhosh) |
| Ingenieurgesellschaft TGA Palmert&Grässle | 7 | 2 | 2 | 1 | 4 | active (7 signals) |
| Company (chat.de) | 6 | 1 | 1 | 1 | 1 | active (6 signals) |
| admi Kommunal GmbH | 6 | 1 | 1 | 1 | 57 | active (6 signals) |
| Lavette GmbH | 4 | 2 | 2 | 2 | 47 | active (4 signals) |
| roewert.de | 4 | 1 | 1 | 1 | 7 | real construction firm; signup named it after the email domain (override by Santhosh) |
| zed-group.eu | 4 | 1 | 1 | 1 | 0 | real firm; signup named it after the email domain (override by Santhosh) |
| bc-u.at | 4 | 1 | 1 | 1 | 0 | real Austrian firm; signup named it after the email domain (override by Santhosh) |
| Terras Holding GmbH | 3 | 1 | 1 | 1 | 0 | active (3 signals) |
| schrobsdorff.ag | 3 | 1 | 1 | 1 | 12 | real construction firm; signup named it after the email domain (override by Santhosh) |
| lavettegruppe.com | 2 | 1 | 1 | 1 | 38 | identified via duplicate "Lavette GmbH" |
| berlin-bausanierung.de | 2 | 1 | 1 | 1 | 0 | real construction firm; signup named it after the email domain (override by Santhosh) |
| bmf-engineering.de | 2 | 1 | 1 | 1 | 0 | real engineering firm; signup named it after the email domain (override by Santhosh) |
| f-e.de | 2 | 1 | 1 | 1 | 0 | real firm; signup named it after the email domain (override by Santhosh) |
| HNS Bau GmbH | 2 | 1 | 1 | 1 | 0 | active (2 signals) |
| vatter.de | 1 | 1 | 1 | 0 | 1 | real construction firm; signup named it after the email domain (override by Santhosh) |
| kilianprikryl.de | 1 | 1 | 1 | 1 | 0 | real sole trader in the trade; signup named it after the email domain (override by Santhosh) |
| AWD Ingenieurgesellschaft mbH | 1 | 2 | 2 | 0 | 0 | active (1 signals) |
| peter-kalkmann.de | 1 | 1 | 1 | 1 | 0 | real sole trader in the trade; signup named it after the email domain (override by Santhosh) |
| BAU AI | 1 | 1 | 1 | 0 | 2 | active (1 signals) |
| ib-burak.de | 1 | 1 | 1 | 1 | 1 | real engineering office (Ingenieurbüro); signup named it after the email domain (override by Santhosh) |
| koblenzer-wohnbau.de | 1 | 1 | 1 | 1 | 0 | real construction firm; signup named it after the email domain (override by Santhosh) |
| knapp-kubitza.de | 1 | 1 | 1 | 1 | 1 | real engineering/architecture practice; signup named it after the email domain (override by Santhosh) |
| ass-bauberatung.de | 1 | 1 | 1 | 1 | 0 | real construction consultancy; signup named it after the email domain (override by Santhosh) |

## Needs review

These have real activity but a name that does not prove they are a real firm —
signup derived it from the user's email domain. Some are genuine customers.

| Company | Activity | Members | Signed in | Active ≤180d | Docs | Reason |
|---|---:|---:|---:|---:|---:|---|

## Proposed merges

| Survivor (keeps the data) | Absorbs | Final name | Match key |
|---|---|---|---|
| BAU AI GmbH | BAU AI | BAU AI GmbH | `bauai` |
| hns-bau-gmbh.de | HNS Bau GmbH | HNS Bau GmbH | `hnsbau` |
| Lavette GmbH | lavettegruppe.com | Lavette GmbH | `lavette` |
| WIRL INGENIEURE GMBH | Wirl Ingenieure GmbH | WIRL INGENIEURE GMBH | `wirlingenieure` |

## Excluded

Listed so an over-eager filter is caught at sign-off rather than after cutover.

| Company | Activity | Members | Signed in | Active ≤180d | Docs | Reason |
|---|---:|---:|---:|---:|---:|---|
| testtw.de | 34 | 1 | 1 | 1 | 0 | test/demo name pattern |
| newdigitalcraft.com | 9 | 1 | 1 | 1 | 0 | not a construction customer (override by Santhosh) |
| ro12121.eu | 7 | 1 | 1 | 1 | 0 | throwaway signup, not a real firm (override by Santhosh) |
| architekttest.de | 6 | 1 | 1 | 1 | 8 | test/demo name pattern |
| proton.me | 6 | 1 | 1 | 1 | 3 | personal mail domain, no identifiable firm (override by Santhosh) |
| yahoo.de | 6 | 1 | 1 | 1 | 0 | personal mail domain, no identifiable firm (override by Santhosh) |
| catrin.com | 5 | 1 | 1 | 1 | 0 | not a construction customer (override by Santhosh) |
| Bauunternehmung SE | 5 | 1 | 1 | 1 | 0 | johann-bunte.de — only account is baufirm@baufirmatest.de; an internal signup against a real firm's website, not a customer (override by Santhosh) |
| tushar.com | 5 | 1 | 1 | 1 | 0 | test/demo name pattern |
| olipii.com | 5 | 4 | 4 | 4 | 0 | not a construction customer (override by Santhosh) |
| Test Company | 4 | 110 | 14 | 7 | 1 | signup fallback bucket (110 members) |
| _(no name)_ | 4 | 0 | 0 | 0 | 4 | no company name |
| thinkmates.in | 4 | 1 | 1 | 1 | 1 | not a construction customer (override by Santhosh) |
| spaceera.de | 4 | 1 | 1 | 1 | 19 | not a construction customer (override by Santhosh) |
| emma.de | 3 | 1 | 1 | 1 | 0 | not a construction customer (override by Santhosh) |
| local1.net | 3 | 1 | 1 | 1 | 20 | not a construction customer (override by Santhosh) |
| tushar123.com | 3 | 1 | 1 | 1 | 0 | test/demo name pattern |
| GREBNER Ingenieure GmbH | 3 | 1 | 1 | 1 | 0 | grebner-ingenieure.de — only account is a disposable mailbox (amupx.com); not a customer (override by Santhosh) |
| daui.info | 3 | 1 | 1 | 1 | 0 | not a construction customer (override by Santhosh) |
| yycc.eu | 3 | 1 | 1 | 1 | 0 | throwaway signup, not a real firm (override by Santhosh) |
| anirban.com | 2 | 1 | 1 | 1 | 4 | test/demo name pattern |
| testoli.com | 2 | 1 | 1 | 1 | 0 | test/demo name pattern |
| holzbaufirmatest.de | 2 | 1 | 1 | 1 | 2 | test/demo name pattern |
| bau.co | 2 | 1 | 1 | 1 | 0 | generic throwaway signup (override by Santhosh) |
| bltiwd.com | 2 | 2 | 2 | 2 | 0 | throwaway signup, not a real firm (override by Santhosh) |
| bwmyga.com | 2 | 2 | 2 | 2 | 0 | throwaway signup, not a real firm (override by Santhosh) |
| BAU AI (test) | 1 | 1 | 1 | 1 | 0 | test/demo name pattern |
| buildingradar.com | 1 | 1 | 1 | 0 | 1 | construction-tech vendor evaluating the product, not a customer (override by Santhosh) |
| IPB – Ingenieurbüro für Bauplanung und Beratung GmbH | 1 | 1 | 1 | 1 | 1 | ipb-thale.de — only account is admin@test.net; internal signup, not a customer (override by Santhosh) |
| test9.com | 1 | 1 | 1 | 1 | 0 | test/demo name pattern |
| bau.eu | 1 | 1 | 1 | 1 | 0 | generic throwaway signup (duplicate of bau.co) (override by Santhosh) |
| yzcalo.com | 1 | 4 | 4 | 4 | 0 | not a construction customer (override by Santhosh) |
| devtest10.com | 1 | 1 | 1 | 1 | 0 | test/demo name pattern |
| testingdev.com | 1 | 1 | 1 | 1 | 0 | test/demo name pattern |
| twp.mountholly.nj.us | 0 | 1 | 0 | 0 | 0 | no activity |
| cadinr.com | 0 | 1 | 0 | 0 | 0 | no activity |
| 50.com | 0 | 1 | 0 | 0 | 0 | no activity |
| publicstorage.ca | 0 | 1 | 0 | 0 | 0 | no activity |
| a7goldinvest.ru | 0 | 1 | 0 | 0 | 0 | no activity |
| mba2025.hbs.edu | 0 | 1 | 0 | 0 | 0 | no activity |
| Gutthann Hiw Architekten | 0 | 1 | 1 | 0 | 0 | no activity |
| msn.com | 0 | 1 | 0 | 0 | 0 | no activity |
| BSG Bau-Service GmbH | 0 | 1 | 1 | 1 | 0 | no activity |
| outlook.com | 0 | 1 | 0 | 0 | 0 | no activity |
| homeremodelingcenter.com | 0 | 1 | 0 | 0 | 0 | no activity |
| t-online.de | 0 | 2 | 0 | 0 | 0 | no activity |
| me.com | 0 | 1 | 0 | 0 | 0 | no activity |
| spacex.com | 0 | 1 | 0 | 0 | 0 | no activity |
| aol.com | 0 | 6 | 0 | 0 | 0 | no activity |
| rivercityrush.com | 0 | 1 | 0 | 0 | 0 | no activity |
| a7gi.ru | 0 | 3 | 0 | 0 | 0 | no activity |
| chameleongroup.co | 0 | 8 | 0 | 0 | 0 | no activity |
| sbcglobal.net | 0 | 1 | 0 | 0 | 0 | no activity |
| Company (gmai.com) | 0 | 0 | 0 | 0 | 0 | no activity |
| Tembau | 0 | 1 | 1 | 0 | 0 | no activity |
| Company (adityamohan.com) | 0 | 1 | 0 | 0 | 0 | no activity |
| ray | 0 | 1 | 0 | 0 | 0 | no activity |
| anirban2.com | 0 | 1 | 0 | 0 | 0 | test/demo name pattern |
| test | 0 | 11 | 0 | 0 | 0 | test/demo name pattern |
| olaar.de | 0 | 1 | 0 | 0 | 0 | no activity |
| Student | 0 | 1 | 0 | 0 | 0 | no activity |
| yahoo.com | 0 | 12 | 0 | 0 | 0 | no activity |
| lignoalp.com | 0 | 1 | 0 | 0 | 0 | no activity |
| halo.com | 0 | 1 | 0 | 0 | 0 | no activity |
| bau.com | 0 | 1 | 1 | 1 | 0 | no activity |
| trt.eu | 0 | 1 | 1 | 1 | 0 | no activity |
| gebr-silbe.de | 0 | 1 | 0 | 0 | 0 | no activity |
| pricing1.com | 0 | 1 | 0 | 0 | 0 | test/demo name pattern |
| keiner | 0 | 1 | 0 | 0 | 0 | no activity |
| bcdtravel.ch | 0 | 1 | 0 | 0 | 0 | no activity |
| anirban3.com | 0 | 1 | 0 | 0 | 0 | test/demo name pattern |
| pricing152.com | 0 | 1 | 1 | 1 | 0 | test/demo name pattern |
| bauaiai.eu | 0 | 1 | 1 | 1 | 0 | no activity |
| cricket.com | 0 | 1 | 1 | 1 | 0 | no activity |
| sigizmundgrp.com | 0 | 1 | 0 | 0 | 0 | no activity |
| demo12345.com | 0 | 1 | 1 | 0 | 0 | test/demo name pattern |
| anirban10.com | 0 | 0 | 0 | 0 | 0 | test/demo name pattern |
| GFM Ingenieure GmbH & Co. KG | 0 | 1 | 1 | 1 | 76 | no activity |
| dietrich-bergler.de | 0 | 1 | 1 | 0 | 0 | no activity |
| take2games.com | 0 | 1 | 0 | 0 | 0 | no activity |
| graebert.com | 0 | 1 | 1 | 0 | 0 | no activity |
| test12.ccdd | 0 | 1 | 1 | 1 | 7 | test/demo name pattern |
| ug-behnen.com | 0 | 1 | 0 | 0 | 0 | no activity |
| amax-online.de | 0 | 1 | 0 | 0 | 0 | no activity |
| talktalk.net | 0 | 1 | 0 | 0 | 0 | no activity |
| mcgill.ca | 0 | 1 | 0 | 0 | 0 | no activity |
| bauaidev.com | 0 | 1 | 1 | 1 | 0 | no activity |
| vimeo.com | 0 | 1 | 0 | 0 | 0 | no activity |
| serverius.net | 0 | 1 | 0 | 0 | 0 | no activity |
| bekbg.com | 0 | 1 | 0 | 0 | 0 | no activity |
| bellsouth.net | 0 | 1 | 0 | 0 | 0 | no activity |
| gaddysurveydesign.com | 0 | 1 | 0 | 0 | 0 | no activity |
| assetliving.com | 0 | 1 | 0 | 0 | 0 | no activity |
| buckner.com | 0 | 1 | 0 | 0 | 0 | no activity |
| hk-fe.de | 0 | 1 | 1 | 1 | 0 | no activity |
| anirb | 0 | 0 | 0 | 0 | 0 | no activity |
| lean.pm.gmbh | 0 | 1 | 0 | 0 | 0 | no activity |
| renolit.com | 0 | 1 | 0 | 0 | 0 | no activity |
| Terravis Biogas | 0 | 1 | 1 | 0 | 0 | no activity |
| ZukunftsHaus Sanierung & Energie GmbH & Co.KG | 0 | 1 | 1 | 0 | 0 | no activity |
| Company (dyproject.ch) | 0 | 1 | 1 | 1 | 0 | no activity |
| barkhaus.com | 0 | 1 | 0 | 0 | 0 | no activity |
| Company (test.com) | 0 | 2 | 1 | 0 | 0 | test/demo name pattern |
| implenia.com | 0 | 1 | 1 | 0 | 0 | no activity |
| verizon.net | 0 | 1 | 0 | 0 | 0 | no activity |
| A Company3 | 0 | 0 | 0 | 0 | 0 | no activity |
| Wi | 0 | 0 | 0 | 0 | 0 | no activity |
| GFM Ingenieure GmbH | 0 | 0 | 0 | 0 | 0 | no activity |
| bncinema.com | 0 | 1 | 0 | 0 | 0 | no activity |
| ddd.ttt | 0 | 1 | 1 | 1 | 0 | no activity |
| brentwoodindustries.com | 0 | 1 | 0 | 0 | 0 | no activity |
| burgessniple.com | 0 | 1 | 0 | 0 | 0 | no activity |
| oncor.com | 0 | 1 | 0 | 0 | 0 | no activity |
| melior-gmbh.de | 0 | 1 | 1 | 1 | 0 | no activity |
| new | 0 | 0 | 0 | 0 | 0 | no activity |
| lean-pm.gmbh | 0 | 1 | 0 | 0 | 0 | no activity |
| buv-gmbh.de | 0 | 1 | 0 | 0 | 0 | no activity |
| schryver.com | 0 | 1 | 0 | 0 | 0 | no activity |
| weiss-technik.com | 0 | 1 | 0 | 0 | 0 | no activity |
| werkbank-digital.de | 0 | 1 | 0 | 0 | 0 | no activity |
| testfit.com | 0 | 1 | 1 | 1 | 0 | test/demo name pattern |
| zweim.ch | 0 | 1 | 0 | 0 | 0 | no activity |
| Pending Setup | 0 | 1 | 1 | 1 | 0 | no activity |
| demo0000888.com | 0 | 0 | 0 | 0 | 0 | test/demo name pattern |
| demo112.com | 0 | 0 | 0 | 0 | 0 | test/demo name pattern |
| hpmc Projektmanagement & Consulting GmbH | 0 | 1 | 1 | 0 | 0 | no activity |
| Value Plan | 0 | 1 | 1 | 0 | 0 | no activity |
| A Company C | 0 | 0 | 0 | 0 | 0 | no activity |
| anirban4.com | 0 | 0 | 0 | 0 | 0 | test/demo name pattern |
| Company (trade.eu) | 0 | 1 | 1 | 0 | 0 | no activity |
| Rhein&Rur Design / ProBuildAi | 0 | 1 | 0 | 0 | 0 | no activity |
| badgerhole.com | 0 | 1 | 0 | 0 | 0 | no activity |
| gmx.de | 0 | 5 | 0 | 0 | 0 | no activity |
| baubuild.com | 0 | 1 | 1 | 1 | 0 | no activity |
| testaaa.com | 0 | 1 | 1 | 1 | 0 | test/demo name pattern |
| immo-bau.biz | 0 | 1 | 0 | 0 | 0 | no activity |
| Wirl Ingenieure G | 0 | 0 | 0 | 0 | 0 | no activity |
| Company Test Name | 0 | 1 | 1 | 0 | 3 | test/demo name pattern |
| guerrillamailblock.com | 0 | 0 | 0 | 0 | 0 | no activity |
| nwer.nwer | 0 | 1 | 1 | 1 | 0 | no activity |
| buve-gmbh.de | 0 | 1 | 1 | 1 | 0 | no activity |
| bauai.com | 0 | 0 | 0 | 0 | 0 | no activity |
| diehl-bauunternehmen.de | 0 | 1 | 0 | 0 | 0 | no activity |
| demo435.com | 0 | 0 | 0 | 0 | 0 | test/demo name pattern |
| Anirban's Company | 0 | 1 | 1 | 0 | 0 | test/demo name pattern |
| Otto House Manufactur L.L.C. | 0 | 1 | 1 | 0 | 0 | no activity |
| Test Bau Firma | 0 | 1 | 1 | 0 | 0 | test/demo name pattern |
| Bürokrates | 0 | 7 | 0 | 0 | 0 | no activity |
| Test GmbH | 0 | 1 | 1 | 0 | 0 | test/demo name pattern |
| AWD Engineers | 0 | 1 | 1 | 0 | 0 | no activity |
| YASH | 0 | 1 | 0 | 0 | 0 | no activity |
| demo777.com | 0 | 0 | 0 | 0 | 0 | test/demo name pattern |
| Simon Wübbels Architekt | 0 | 1 | 0 | 0 | 0 | no activity |
| anirbannnnnnn | 0 | 1 | 1 | 0 | 0 | test/demo name pattern |
| Company (business.com) | 0 | 2 | 2 | 0 | 0 | no activity |
| evoqon.com | 0 | 1 | 1 | 1 | 0 | no activity |
| 123prcing.com | 0 | 1 | 1 | 1 | 0 | no activity |
| Acme | 0 | 0 | 0 | 0 | 0 | no activity |
| 7-11.com | 0 | 1 | 0 | 0 | 0 | no activity |
| Company (demo5.com) | 0 | 0 | 0 | 0 | 0 | test/demo name pattern |
| wittconstruction.com | 0 | 1 | 0 | 0 | 0 | no activity |
| securitydelta.nl | 0 | 2 | 0 | 0 | 0 | no activity |
| jor-mac.com | 0 | 1 | 0 | 0 | 0 | no activity |
| test.eu | 0 | 1 | 1 | 1 | 0 | test/demo name pattern |
| web.de | 0 | 2 | 0 | 0 | 0 | no activity |
| hacknapp.com | 0 | 1 | 0 | 0 | 0 | no activity |
| kimballne.org | 0 | 1 | 0 | 0 | 0 | no activity |
| ambling.com | 0 | 1 | 0 | 0 | 0 | no activity |
| mindsquare.de | 0 | 1 | 0 | 0 | 0 | no activity |
| comcast.net | 0 | 2 | 0 | 0 | 0 | no activity |
| tuta.com | 0 | 1 | 0 | 0 | 0 | no activity |
| raytechnologie.co | 0 | 1 | 0 | 0 | 0 | no activity |
| gmx.net | 0 | 1 | 0 | 0 | 0 | no activity |
| 80i.com | 0 | 1 | 0 | 0 | 0 | no activity |
| recom-power.com | 0 | 1 | 0 | 0 | 0 | no activity |
| roer.eu | 0 | 1 | 0 | 0 | 0 | no activity |
| logabau-gmbh.de | 0 | 1 | 0 | 0 | 0 | no activity |
| pesalliance.org | 0 | 1 | 0 | 0 | 0 | no activity |
| live.com | 0 | 1 | 0 | 0 | 0 | no activity |
| pricingp1.com | 0 | 1 | 1 | 1 | 0 | test/demo name pattern |
| trial.nnn | 0 | 1 | 1 | 1 | 0 | test/demo name pattern |
| demooo23.com | 0 | 0 | 0 | 0 | 0 | test/demo name pattern |
| chimphaven.org | 0 | 1 | 0 | 0 | 0 | no activity |
| bauai.er | 0 | 1 | 1 | 1 | 0 | no activity |
| hotmail.de | 0 | 1 | 0 | 0 | 0 | no activity |
| anirbananirban.com | 0 | 1 | 1 | 1 | 0 | test/demo name pattern |
| rrr.ccc | 0 | 1 | 1 | 1 | 0 | no activity |
| final.com | 0 | 1 | 1 | 1 | 0 | no activity |
| priniting.com | 0 | 1 | 0 | 0 | 0 | no activity |
| gu.com | 0 | 1 | 1 | 1 | 0 | no activity |
| eastsunshineventures.com | 0 | 1 | 0 | 0 | 0 | no activity |
| horizonsatellite.com | 0 | 1 | 0 | 0 | 0 | no activity |
| ida-ing.de | 0 | 1 | 1 | 1 | 0 | no activity |
| kittytester.com | 0 | 1 | 1 | 1 | 0 | test/demo name pattern |
| bersqey.com | 0 | 1 | 0 | 0 | 0 | no activity |
| outlook.de | 0 | 1 | 0 | 0 | 0 | no activity |
| miligrant.com | 0 | 1 | 1 | 1 | 0 | no activity |
| rogers.com | 0 | 1 | 0 | 0 | 0 | no activity |
| testziio.com | 0 | 1 | 1 | 1 | 0 | test/demo name pattern |
| wieser.it | 0 | 1 | 0 | 0 | 0 | no activity |
| testte.eu | 0 | 1 | 1 | 1 | 0 | test/demo name pattern |
| vaf.com | 0 | 1 | 0 | 0 | 0 | no activity |
| hagemeyer-gmbh.de | 0 | 1 | 0 | 0 | 0 | no activity |
| glitsch-gs.de | 0 | 1 | 0 | 0 | 0 | no activity |
| crusher.com | 0 | 1 | 1 | 1 | 0 | no activity |
| bbg-immobilien.com | 0 | 1 | 0 | 0 | 0 | no activity |
| aleph-alpha.com | 0 | 1 | 1 | 1 | 0 | no activity |
| pricing.com | 0 | 2 | 1 | 1 | 0 | test/demo name pattern |
| baf.com | 0 | 1 | 1 | 1 | 0 | no activity |
| pricingtesting.com | 0 | 1 | 1 | 1 | 0 | test/demo name pattern |
| demo.co.in | 0 | 1 | 1 | 1 | 0 | test/demo name pattern |
| vapi.eu | 0 | 1 | 0 | 0 | 0 | no activity |
| elektro-wagner.online | 0 | 1 | 1 | 1 | 0 | no activity |
| un.eu | 0 | 1 | 1 | 1 | 0 | no activity |
| ere.com | 0 | 1 | 1 | 1 | 0 | no activity |
| ozsaip.com | 0 | 1 | 1 | 1 | 0 | no activity |
| zwei15.com | 0 | 1 | 0 | 0 | 0 | no activity |
| anqerra.com | 0 | 1 | 0 | 0 | 0 | no activity |
| biancaschroeder.ai | 0 | 1 | 0 | 0 | 0 | no activity |
| forliion.com | 0 | 0 | 0 | 0 | 0 | no activity |
| ipg95.de | 0 | 1 | 0 | 0 | 0 | no activity |
| june.com | 0 | 1 | 1 | 1 | 0 | no activity |
| sb-bau.de | 0 | 1 | 0 | 0 | 0 | no activity |
| minitts.net | 0 | 1 | 1 | 1 | 0 | no activity |
| ruutukf.com | 0 | 1 | 1 | 1 | 0 | no activity |
| franz-traub.de | 0 | 1 | 0 | 0 | 0 | no activity |
| elektro-kamphausen.de | 0 | 1 | 0 | 0 | 0 | no activity |
| testing15.com | 0 | 1 | 1 | 1 | 0 | test/demo name pattern |
| lnovic.com | 0 | 2 | 1 | 1 | 0 | no activity |
| heinekamp.com | 0 | 1 | 1 | 1 | 0 | no activity |
| rpaintel.com | 0 | 2 | 1 | 1 | 0 | no activity |
| diete-siepmann.de | 0 | 1 | 1 | 1 | 0 | no activity |
| primetor.com | 0 | 1 | 1 | 1 | 0 | no activity |
| aon.at | 0 | 1 | 0 | 0 | 0 | no activity |
