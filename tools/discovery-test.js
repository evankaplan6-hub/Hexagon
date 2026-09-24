'use strict';
// Assertions for src/discovery.js -- no network, no wall clock.
//
// Discovery walks every open market on both venues so the matcher can pair outcomes outside games
// and Fed brackets. What has to hold: only markets a pair could actually trade come through (open,
// quoted, not a placeholder, not sports), each carries the fields the matcher and the rules gate
// read, with its rules clipped but hashed whole; a crawl survives a 429 and ends honestly
// (`complete: false`, earlier pages kept) when a page will not come; Gamma's 2000-offset wall and
// the volume floor end the Polymarket walk; and the registry on disk round-trips and never throws.
//
// The fixtures are trimmed excerpts of real pages read on 2026-09-15: Kalshi GET /events?status=open
// &with_nested_markets=true&limit=200 (first page) and Gamma GET /events?closed=false&active=true
// &order=volume24hr (offset 0). Rules and descriptions are cut short; everything else is verbatim.
//
//   node tools/discovery-test.js
const crypto = require('crypto');
const http = require('../src/http');
const D = require('../src/discovery');

let pass = 0, fail = 0;
const ok = (name, cond, got) => {
  if (cond) { pass++; return; }
  fail++;
  console.log(`  FAIL  ${name}${got === undefined ? '' : `\n        got: ${JSON.stringify(got)}`}`);
};
const group = (n) => console.log(`\n${n}`);

const sha1 = (s) => crypto.createHash('sha1').update(s, 'utf8').digest('hex');
const clone = (x) => JSON.parse(JSON.stringify(x));

// ---------------------------------------------------------------- fixtures (real shapes)

const KS_DNC = {"category":"Politics","event_ticker":"KXNEXTDNCCHAIR-45","series_ticker":"KXNEXTDNCCHAIR","title":"Who will be the next DNC Chair?","sub_title":"Before Jan 1, 2045","mutually_exclusive":true,"strike_period":"",
  markets: [
    {"ticker":"KXNEXTDNCCHAIR-45-BWIK","event_ticker":"KXNEXTDNCCHAIR-45","title":"Will Ben Wikler be the next Chair of the Democratic National Committee?","yes_sub_title":"Ben Wikler","no_sub_title":"Ben Wikler","status":"active","market_type":"binary","strike_type":"custom","custom_strike":{"Holder":"Ben Wikler"},"yes_bid_dollars":"0.0000","yes_ask_dollars":"0.0810","last_price_dollars":"0.0540","volume_24h_fp":"0.00","open_interest_fp":"107.84","close_time":"2045-01-08T15:00:00Z","expected_expiration_time":"2045-01-08T15:00:00Z","latest_expiration_time":"2045-01-08T15:00:00Z","can_close_early":true,"result":"","rules_primary":"If Ben Wikler formally holds Chair of the Democratic National Committee before Jan 1, 2045, and is the first such subject to do so after Issuance, then the market resolves to Yes.","rules_secondary":"For the purposes of this Contract, \"formally holds Chair of the Democratic National Committee\" means that an individual, company, or group has assumed Chair of "},
    {"ticker":"KXNEXTDNCCHAIR-45-MOMA","event_ticker":"KXNEXTDNCCHAIR-45","title":"Will Martin O’Malley be the next Chair of the Democratic National Committee?","yes_sub_title":"Martin O’Malley","no_sub_title":"Martin O’Malley","status":"active","market_type":"binary","strike_type":"custom","custom_strike":{"Holder":"Martin O’Malley"},"yes_bid_dollars":"0.0850","yes_ask_dollars":"0.1800","last_price_dollars":"0.1700","volume_24h_fp":"0.00","open_interest_fp":"11.00","close_time":"2045-01-08T15:00:00Z","expected_expiration_time":"2045-01-08T15:00:00Z","latest_expiration_time":"2045-01-08T15:00:00Z","can_close_early":true,"result":"","rules_primary":"If Martin O’Malley formally holds Chair of the Democratic National Committee before Jan 1, 2045, and is the first such subject to do so after Issuance, then the market resolves to Yes.","rules_secondary":"For the purposes of this Contract, \"formally holds Chair of the Democratic National Committee\" means that an individual, company, or group has assumed Chair of "},
  ] };
const KS_FED = {"category":"Economics","event_ticker":"KXFEDFUNDSYEAR-37JAN01","series_ticker":"KXFEDFUNDSYEAR","title":"Fed funds rate at end of 2036","sub_title":"December 31, 2036","mutually_exclusive":false,"strike_period":"",
  markets: [
    {"ticker":"KXFEDFUNDSYEAR-37JAN01-T1.00","event_ticker":"KXFEDFUNDSYEAR-37JAN01","title":"Will the upper bound of the target range for the federal funds rate in effect at 11:59 PM ET on December 31, 2036 be above 1.00%?","yes_sub_title":"Above 1.00%","no_sub_title":"Above 1.00%","status":"active","market_type":"binary","strike_type":"greater","floor_strike":1,"yes_bid_dollars":"0.4600","yes_ask_dollars":"0.9500","last_price_dollars":"0.6800","volume_24h_fp":"0.00","open_interest_fp":"8.01","close_time":"2037-01-01T04:59:00Z","expected_expiration_time":"2037-01-08T06:30:00Z","latest_expiration_time":"2037-01-08T06:30:00Z","can_close_early":true,"result":"","rules_primary":"If the upper bound of the target range for the federal funds rate in effect at 11:59 PM ET on December 31, 2036, as published on the Federal Reserve’s official website, is above 1.00%, then the market resolves to Yes.","rules_secondary":"If the Federal Reserve specifies a single target rate rather than a target range, that target rate will be used."},
    {"ticker":"KXFEDFUNDSYEAR-37JAN01-T1.25","event_ticker":"KXFEDFUNDSYEAR-37JAN01","title":"Will the upper bound of the target range for the federal funds rate in effect at 11:59 PM ET on December 31, 2036 be above 1.25%?","yes_sub_title":"Above 1.25%","no_sub_title":"Above 1.25%","status":"active","market_type":"binary","strike_type":"greater","floor_strike":1.25,"yes_bid_dollars":"0.6700","yes_ask_dollars":"0.9100","last_price_dollars":"0.7100","volume_24h_fp":"0.00","open_interest_fp":"25.01","close_time":"2037-01-01T04:59:00Z","expected_expiration_time":"2037-01-08T06:30:00Z","latest_expiration_time":"2037-01-08T06:30:00Z","can_close_early":true,"result":"","rules_primary":"If the upper bound of the target range for the federal funds rate in effect at 11:59 PM ET on December 31, 2036, as published on the Federal Reserve’s official website, is above 1.25%, then the market resolves to Yes.","rules_secondary":"If the Federal Reserve specifies a single target rate rather than a target range, that target rate will be used."},
  ] };
const KS_STAFFORD = {"category":"Sports","event_ticker":"KXNFLRETIRE-MSTAFFORD9","series_ticker":"KXNFLRETIRE","title":"Matthew Stafford: Retirement","sub_title":"Matthew Stafford","mutually_exclusive":false,"strike_period":"",
  markets: [
    {"ticker":"KXNFLRETIRE-MSTAFFORD9-2627","event_ticker":"KXNFLRETIRE-MSTAFFORD9","title":"Will Matthew Stafford announce his retirement before the 2026-27 NFL season?","yes_sub_title":"Before the 2026-27 season","no_sub_title":"Before the 2026-27 season","status":"finalized","market_type":"binary","strike_type":"structured","custom_strike":{"football_player":"3a248cd7-2cbc-4ec7-ad38-1d1712298293"},"yes_bid_dollars":"0.0000","yes_ask_dollars":"1.0000","last_price_dollars":"0.0100","volume_24h_fp":"0.00","open_interest_fp":"50.00","close_time":"2026-09-09T23:42:18Z","expected_expiration_time":"2031-09-30T14:00:00Z","latest_expiration_time":"2026-09-30T03:59:00Z","can_close_early":true,"result":"no","settlement_value_dollars":"0.0000","rules_primary":"If Matthew Stafford announces his retirement from the NFL before the 2026-27 NFL season start date, then the market resolves to Yes.","rules_secondary":"Note: The retirement must be intended to be effective immediately or prior to the first new season after the announcement.\n\nFor the purposes of this market, the"},
    {"ticker":"KXNFLRETIRE-MSTAFFORD9-2728","event_ticker":"KXNFLRETIRE-MSTAFFORD9","title":"Will Matthew Stafford announce his retirement before the 2027-28 NFL season?","yes_sub_title":"Before the 2027-28 season","no_sub_title":"Before the 2027-28 season","status":"active","market_type":"binary","strike_type":"structured","custom_strike":{"football_player":"3a248cd7-2cbc-4ec7-ad38-1d1712298293"},"yes_bid_dollars":"0.1500","yes_ask_dollars":"0.9800","last_price_dollars":"0.6500","volume_24h_fp":"0.00","open_interest_fp":"216.55","close_time":"2027-09-30T03:59:00Z","expected_expiration_time":"2031-09-30T14:00:00Z","latest_expiration_time":"2027-09-30T03:59:00Z","can_close_early":true,"result":"","rules_primary":"If Matthew Stafford announces his retirement from the NFL before the 2027-28 NFL season start date, then the market resolves to Yes.","rules_secondary":"Note: The retirement must be intended to be effective immediately or prior to the first new season after the announcement.\n\nFor the purposes of this market, the"},
    {"ticker":"KXNFLRETIRE-MSTAFFORD9-2829","event_ticker":"KXNFLRETIRE-MSTAFFORD9","title":"Will Matthew Stafford announce his retirement before the 2028-29 NFL season?","yes_sub_title":"Before the 2028-29 season","no_sub_title":"Before the 2028-29 season","status":"active","market_type":"binary","strike_type":"structured","custom_strike":{"football_player":"3a248cd7-2cbc-4ec7-ad38-1d1712298293"},"yes_bid_dollars":"0.0200","yes_ask_dollars":"0.8200","last_price_dollars":"0.8200","volume_24h_fp":"0.00","open_interest_fp":"111.78","close_time":"2028-09-30T03:59:00Z","expected_expiration_time":"2031-09-30T14:00:00Z","latest_expiration_time":"2028-09-30T03:59:00Z","can_close_early":true,"result":"","rules_primary":"If Matthew Stafford announces his retirement from the NFL before the 2028-29 NFL season start date, then the market resolves to Yes.","rules_secondary":"Note: The retirement must be intended to be effective immediately or prior to the first new season after the announcement.\n\nFor the purposes of this market, the"},
    {"ticker":"KXNFLRETIRE-MSTAFFORD9-2930","event_ticker":"KXNFLRETIRE-MSTAFFORD9","title":"Will Matthew Stafford announce his retirement before the 2029-30 NFL season?","yes_sub_title":"Before the 2029-30 season","no_sub_title":"Before the 2029-30 season","status":"active","market_type":"binary","strike_type":"structured","custom_strike":{"football_player":"3a248cd7-2cbc-4ec7-ad38-1d1712298293"},"yes_bid_dollars":"0.0200","yes_ask_dollars":"0.8300","last_price_dollars":"0.8300","volume_24h_fp":"0.00","open_interest_fp":"100.18","close_time":"2029-09-30T03:59:00Z","expected_expiration_time":"2031-09-30T14:00:00Z","latest_expiration_time":"2029-09-30T03:59:00Z","can_close_early":true,"result":"","rules_primary":"If Matthew Stafford announces his retirement from the NFL before the 2029-30 NFL season start date, then the market resolves to Yes.","rules_secondary":"Note: The retirement must be intended to be effective immediately or prior to the first new season after the announcement.\n\nFor the purposes of this market, the"},
  ] };
const KS_CPI = {"category":"Economics","event_ticker":"KXUSCPIYEAR-36FEB01","series_ticker":"KXUSCPIYEAR","title":"US headline CPI inflation in December 2035","sub_title":"December 2035","mutually_exclusive":false,"strike_period":"",
  markets: [
    {"ticker":"KXUSCPIYEAR-36FEB01-T2.0","event_ticker":"KXUSCPIYEAR-36FEB01","title":"Will the 12-month percentage change in CPI-U in December 2035 be above 2.0%?","yes_sub_title":"Above 2.0%","no_sub_title":"Above 2.0%","status":"active","market_type":"binary","strike_type":"greater","floor_strike":2,"yes_bid_dollars":"0.0000","yes_ask_dollars":"1.0000","last_price_dollars":"0.6600","volume_24h_fp":"0.00","open_interest_fp":"3.04","close_time":"2036-02-01T04:59:00Z","expected_expiration_time":"2036-02-08T06:30:00Z","latest_expiration_time":"2036-02-08T06:30:00Z","can_close_early":true,"result":"","rules_primary":"If the 12-month percentage change in CPI-U, U.S. city average, all items, not seasonally adjusted, in December 2035 is above 2.0%, then the market resolves to Yes.","rules_secondary":"The initially reported value for December 2035 will be used. This market concerns the 12-month percentage change for December 2035, not the annual-average perce"},
    {"ticker":"KXUSCPIYEAR-36FEB01-T0.0","event_ticker":"KXUSCPIYEAR-36FEB01","title":"Will the 12-month percentage change in CPI-U in December 2035 be above 0.0%?","yes_sub_title":"Above 0.0%","no_sub_title":"Above 0.0%","status":"active","market_type":"binary","strike_type":"greater","floor_strike":0,"yes_bid_dollars":"0.1800","yes_ask_dollars":"1.0000","last_price_dollars":"0.9000","volume_24h_fp":"0.00","open_interest_fp":"23.00","close_time":"2036-02-01T04:59:00Z","expected_expiration_time":"2036-02-08T06:30:00Z","latest_expiration_time":"2036-02-08T06:30:00Z","can_close_early":true,"result":"","rules_primary":"If the 12-month percentage change in CPI-U, U.S. city average, all items, not seasonally adjusted, in December 2035 is above 0.0%, then the market resolves to Yes.","rules_secondary":"The initially reported value for December 2035 will be used. This market concerns the 12-month percentage change for December 2035, not the annual-average perce"},
  ] };
const PM_FED = {"id":"481717","slug":"fed-decision-in-september-762","title":"Fed Decision in September?","volume24hr":19676284.57401001,"negRisk":true,"resolutionSource":"","tags":[{"label":"fomc","slug":"fomc"},{"label":"Economic Policy","slug":"economic-policy"},{"label":"Fed Rates","slug":"fed-rates"},{"label":"Jerome Powell","slug":"jerome-powell"},{"label":"Politics","slug":"politics"},{"label":"Fed","slug":"fed"}],
  markets: [
    {"id":"2252243","question":"Will the Fed decrease interest rates by 25 bps after the September 2026 meeting?","conditionId":"0xac02cbb049e46d6a3627c0fdf52fa554982a9025d45968207b362acb6ca4b830","slug":"will-the-fed-decrease-interest-rates-by-25-bps-after-the-september-2026-meeting-586","endDate":"2026-09-16T00:00:00Z","description":"The FED interest rates are defined in this market by the upper bound of the target federal funds range. The decisions on the target federal funds range are made by the Federal Open Market Committee (FOMC) meetings.\n\nThis market will resolve to the amount of ba","outcomes":"[\"Yes\", \"No\"]","outcomePrices":"[\"0.0015\", \"0.9985\"]","clobTokenIds":"[\"57748138085022719760345772310040703848567377822400132842014290209986511882046\", \"28239418772633645184924651434956000849078365566842629564562475378531350731731\"]","active":true,"closed":false,"acceptingOrders":true,"negRisk":true,"negRiskOther":false,"groupItemTitle":"25 bps decrease","bestBid":0.001,"bestAsk":0.002,"spread":0.001,"lastTradePrice":0.002,"volume24hr":4659834.7170359995,"liquidityNum":2920930.31738,"feesEnabled":true,"feeType":"economics_fees","feeSchedule":{"exponent":1,"rate":0.05,"takerOnly":true,"rebateRate":0.25}},
    {"id":"2252242","question":"Will the Fed decrease interest rates by 50+ bps after the September 2026 meeting?","conditionId":"0x5e464d85eb49f22d876f3ed6168a7db5e2288e9ae1eb91effd2758e994676f86","slug":"will-the-fed-decrease-interest-rates-by-50-bps-after-the-september-2026-meeting-863","endDate":"2026-09-16T00:00:00Z","description":"The FED interest rates are defined in this market by the upper bound of the target federal funds range. The decisions on the target federal funds range are made by the Federal Open Market Committee (FOMC) meetings.\n\nThis market will resolve to the amount of ba","outcomes":"[\"Yes\", \"No\"]","outcomePrices":"[\"0.0005\", \"0.9995\"]","clobTokenIds":"[\"97186030785608128217926542396950266594898339988989015155120280107165449433603\", \"81470465080656150088482886298356783621062802919110096763062861781139262816347\"]","active":true,"closed":false,"acceptingOrders":true,"negRisk":true,"negRiskOther":false,"groupItemTitle":"50+ bps decrease","bestAsk":0.001,"spread":0.001,"lastTradePrice":0.001,"volume24hr":820332.65,"liquidityNum":5942201.45157,"feesEnabled":true,"feeType":"economics_fees","feeSchedule":{"exponent":1,"rate":0.05,"takerOnly":true,"rebateRate":0.25}},
  ] };
const PM_RUSSIA = {"id":"149589","slug":"which-party-will-gain-most-seats-in-russian-parliamentary-election","title":"Which party will gain most seats in Russian Parliamentary Election?","volume24hr":1101202.15521,"negRisk":true,"resolutionSource":"","tags":[{"label":"Politics","slug":"politics"},{"label":"International Election Props","slug":"international-election-props"},{"label":"Russia Election","slug":"russia-election"},{"label":"World Elections","slug":"world-elections"},{"label":"Elections","slug":"elections"}],
  markets: [
    {"id":"1130012","question":"Will United Russia (ER) gain the most seats in the next Russian parliamentary election?","conditionId":"0x502a94e5c525766d5ee7f16c6568131ba1b2cbadb69c703af05a6ef00336ed64","slug":"will-united-russia-er-gain-the-most-seats-in-the-next-russian-parliamentary-election","endDate":"2026-09-30T00:00:00Z","description":"Parliamentary elections are to be scheduled to be held in Russia in September 2026.\n\nThis market will resolve according to the political party that gains the greatest number of seats in the next Russian State Duma election, compared to before the election.\n\nIf","outcomes":"[\"Yes\", \"No\"]","outcomePrices":"[\"0.765\", \"0.235\"]","clobTokenIds":"[\"20915769520649892253891152116814645067070024223185517956799957803974344024878\", \"115351075585746600277716377744935410125916932950844626289798775482755919708780\"]","active":true,"closed":false,"acceptingOrders":true,"negRisk":true,"negRiskOther":false,"groupItemTitle":"United Russia (ER)","bestBid":0.76,"bestAsk":0.77,"spread":0.01,"lastTradePrice":0.76,"volume24hr":451007.67517,"liquidityNum":430186.8658,"feesEnabled":false,"feeType":null},
    {"id":"1130017","question":"Will Rodina gain the most seats in the next Russian parliamentary election?","conditionId":"0x2636a06ef9192d50bf0100bf8c857cfe346e8b230978056f2857cb69276e5c46","slug":"will-rodina-gain-the-most-seats-in-the-next-russian-parliamentary-election","endDate":"2026-09-30T00:00:00Z","description":"Parliamentary elections are to be scheduled to be held in Russia in September 2026.\n\nThis market will resolve according to the political party that gains the greatest number of seats in the next Russian State Duma election, compared to before the election.\n\nIf","outcomes":"[\"Yes\", \"No\"]","outcomePrices":"[\"0.0005\", \"0.9995\"]","clobTokenIds":"[\"97795707428382894508371687334156016735780833311849632514604538939263591476606\", \"21823169796744290279577457267056024653655500908800749277001286708277214861043\"]","active":true,"closed":false,"acceptingOrders":true,"negRisk":true,"negRiskOther":false,"groupItemTitle":"Rodina","bestAsk":0.001,"spread":0.001,"lastTradePrice":0.001,"volume24hr":14940,"liquidityNum":254006.65929,"feesEnabled":false,"feeType":null},
    {"id":"1130019","question":"Will Other gain the most seats in the next Russian parliamentary election?","conditionId":"0x09b62d5f56c9023a099a6942e656606f5d7f293aeb5cdb205db1efc40cc50e65","slug":"will-other-gain-the-most-seats-in-the-next-russian-parliamentary-election","endDate":"2026-09-30T00:00:00Z","description":"Parliamentary elections are to be scheduled to be held in Russia in September 2026.\n\nThis market will resolve according to the political party that gains the greatest number of seats in the next Russian State Duma election, compared to before the election.\n\nIf","outcomes":"[\"Yes\", \"No\"]","clobTokenIds":"[\"106985663612285771057611978334880528381690803888262434873198473344682744286164\", \"111432491552465392877198300050724864171969018176369968928012754634523259170187\"]","active":false,"closed":false,"acceptingOrders":true,"negRisk":true,"negRiskOther":true,"groupItemTitle":"Other","bestBid":0,"bestAsk":1,"spread":1,"lastTradePrice":0,"volume24hr":0,"liquidityNum":0,"feesEnabled":false,"feeType":null,"resolutionSource":""},
  ] };
const PM_TAIWAN = {"id":"34044","slug":"will-china-invade-taiwan-before-2027","title":"Will China invade Taiwan by end of 2026?","volume24hr":144264.16278999997,"resolutionSource":"","tags":[{"label":"Politics","slug":"politics"},{"label":"World","slug":"world"},{"label":"Geopolitics","slug":"geopolitics"},{"label":"Foreign Policy","slug":"foreign-policy"},{"label":"China","slug":"china"},{"label":"Earn 4%","slug":"earn-4"}],
  markets: [
    {"id":"567621","question":"Will China invade Taiwan by end of 2026?","conditionId":"0xd9fb1184af0064e5e34b129f5b79afa5a17b7e32f2953ab05efed82315fee6d4","slug":"will-china-invade-taiwan-before-2027","endDate":"2026-12-31T00:00:00Z","description":"This market will resolve to \"Yes\" if China commences a military offensive intended to establish control over any portion of the Republic of China (Taiwan) by December 31, 2026, 11:59 PM ET. Otherwise, this market will resolve to \"No\".\n\nTerritory under the admi","outcomes":"[\"Yes\", \"No\"]","outcomePrices":"[\"0.039\", \"0.961\"]","clobTokenIds":"[\"94559586571241563470235664821564670251180951772614764383113614156422396181162\", \"90772332434487149264114862115632028379978765245278600275169585501290867536237\"]","active":true,"closed":false,"acceptingOrders":true,"negRisk":false,"negRiskOther":false,"groupItemTitle":"","bestBid":0.038,"bestAsk":0.04,"spread":0.002,"lastTradePrice":0.04,"volume24hr":144264.16278999997,"liquidityNum":588210.51853,"feesEnabled":false,"feeType":null,"resolutionSource":""},
  ] };
const PM_SOCCER = {"id":"952074","slug":"lal-ala-val-2026-09-15","title":"Deportivo Alavés vs. Valencia CF","volume24hr":4006673.8687789985,"negRisk":true,"resolutionSource":"https://www.laliga.com/","tags":[{"label":"Sports","slug":"sports"},{"label":"Games","slug":"games"},{"label":"Soccer","slug":"soccer"},{"label":"La Liga","slug":"la-liga"}],
  markets: [
    {"id":"4111371","question":"Will Deportivo Alavés win on 2026-09-15?","conditionId":"0x8b01d6dd942c3b18f6ba8606b93ac7531c8a48c2b3e8622c98c707a9a2c251a5","slug":"lal-ala-val-2026-09-15-ala","endDate":"2026-09-15T18:00:00Z","description":"In the upcoming game, scheduled for September 15, 2026\nIf Deportivo Alavés wins, this market will resolve to \"Yes\".\nOtherwise, this market will resolve to \"No\".\nIf the game is postponed, this market will remain open until the game has been completed.\nIf the ga","outcomes":"[\"Yes\", \"No\"]","outcomePrices":"[\"0.475\", \"0.525\"]","clobTokenIds":"[\"34070873903326512308551939806999682036390469897009365763240571813577238015749\", \"62202648498708590000718762161193939131997649903640604421558354360391504904305\"]","active":true,"closed":false,"acceptingOrders":true,"negRisk":true,"negRiskOther":false,"groupItemTitle":"Deportivo Alavés","bestBid":0.47,"bestAsk":0.48,"spread":0.01,"lastTradePrice":0.48,"volume24hr":3692723.4925869987,"liquidityNum":46888.9873,"feesEnabled":true,"feeType":"sports_fees_v3","feeSchedule":{"exponent":1,"rate":0.05,"takerOnly":true,"rebateRate":0.15},"resolutionSource":"https://www.laliga.com/","gameStartTime":"2026-09-15 18:00:00+00","sportsMarketType":"moneyline"},
  ] };
const PM_ESPORTS = {"id":"1025935","slug":"cs2-forzer-upgrad-2026-09-15","title":"Counter-Strike: FORZE Reload vs UPGRADE (BO3) - CIS LAN Championship Playoffs","volume24hr":369099.950778,"negRisk":false,"resolutionSource":"https://www.twitch.tv/vanfantv","tags":[{"label":"Esports","slug":"esports"},{"label":"counter strike 2","slug":"counter-strike-2"},{"label":"Games","slug":"games"},{"label":"Sports","slug":"sports"}],
  markets: [
    {"id":"4573020","question":"Counter-Strike: FORZE Reload vs UPGRADE - Map 1 Winner","conditionId":"0xdc024ed8fb0ba5bbfd79ac6fc08a8c583e29034da43e663ace05d7dd8c1e17a9","slug":"cs2-forzer-upgrad-2026-09-15-game1","endDate":"2026-09-15T21:30:00Z","description":"This market refers to the Counter-Strike Quarterfinal 3 match between FORZE Reload and UPGRADE in the CIS LAN Championship Playoffs, initially scheduled for September 15, 2026 at 12:00 PM ET.\n\nThis market will resolve to \"FORZE Reload\" if FORZE Reload win Map ","outcomes":"[\"FORZE Reload\", \"UPGRADE\"]","outcomePrices":"[\"0.9995\", \"0.0005\"]","clobTokenIds":"[\"2045264127813449378467820057626190155888520958184349779170291761772722787494\", \"1802174699299608821692283385063543476680957896999298561160128776327503253345\"]","active":true,"closed":false,"acceptingOrders":true,"negRisk":false,"negRiskOther":false,"groupItemTitle":"Map 1 Winner","bestBid":0.999,"bestAsk":1,"spread":0.001,"lastTradePrice":0.999,"volume24hr":17075.867112000004,"liquidityNum":128371.08819,"feesEnabled":true,"feeType":"sports_fees_v3","feeSchedule":{"exponent":1,"rate":0.05,"takerOnly":true,"rebateRate":0.15},"resolutionSource":"https://hltv.org","umaResolutionStatus":"proposed","gameStartTime":"2026-09-15 15:30:00+00","sportsMarketType":"child_moneyline"},
  ] };

const PM_FIGHT = {"id":"991001","slug":"ufc-332-green-ribovics","title":"UFC 332: King Green vs. Esteban Ribovics (Lightweight, Main Card)","volume24hr":0,"tags":[{"label":"Sports","slug":"sports"},{"label":"UFC","slug":"ufc"},{"label":"MMA","slug":"mma"}],
  markets: [
    {"id":"4991001","question":"UFC 332: King Green vs. Esteban Ribovics","conditionId":"0xfight0000000000000000000000000000000000000000000000000000000001","slug":"ufc-332-green-ribovics","endDate":"2026-10-03T23:00:00Z","description":"Winner of the bout.","outcomes":"[\"King Green\", \"Esteban Ribovics\"]","outcomePrices":"[\"0.42\", \"0.58\"]","clobTokenIds":"[\"111\", \"222\"]","active":true,"closed":false,"acceptingOrders":true,"bestBid":0.41,"bestAsk":0.43,"spread":0.02,"volume24hr":0,"feesEnabled":true,"feeSchedule":{"exponent":1,"rate":0.05,"takerOnly":true,"rebateRate":0.15}},
  ] };

// The same four series as GET /series returned them (category, fee_multiplier, fee_type, title).
// KXNEXTDNCCHAIR is the useful one: its events say Politics, the series says Elections.
const SERIES = new Map([
  ['KXNEXTDNCCHAIR', { category: 'Elections', feeMultiplier: 1, feeType: 'quadratic', title: 'Next DNC chair?' }],
  ['KXFEDFUNDSYEAR', { category: 'Economics', feeMultiplier: 1, feeType: 'quadratic', title: 'Fed funds rate at year end' }],
  ['KXNFLRETIRE', { category: 'Sports', feeMultiplier: 1, feeType: 'quadratic', title: 'Pro Football Retirement' }],
  ['KXUSCPIYEAR', { category: 'Economics', feeMultiplier: 1, feeType: 'quadratic', title: 'U.S. headline inflation at year end' }],
]);

// A quiet politics event built from the Taiwan market, for filling Gamma pages to their 100.
function filler(i, vol) {
  const m = { ...PM_TAIWAN.markets[0], id: String(900000 + i), conditionId: `0xfill${i}`, slug: `filler-${i}`, question: `Filler question ${i}?` };
  return { id: String(800000 + i), slug: `filler-${i}`, title: `Filler ${i}`, volume24hr: vol, resolutionSource: '',
    tags: [{ label: 'Politics', slug: 'politics' }], markets: [m] };
}
const fullPage = (from, vol = 1e6) => Array.from({ length: 100 }, (_, i) => filler(from + i, vol));

// A getJSON that serves canned answers and records every url it was asked for. `answer(url, n)` is
// called with the url and how many times that url has been asked for (0 first); a thrown value is
// thrown, anything else returned.
function fakeGet(answer) {
  const calls = [], seen = new Map();
  const getJSON = async (url) => {
    calls.push(url);
    const n = seen.get(url) || 0;
    seen.set(url, n + 1);
    const got = answer(url, n);
    if (got instanceof Error) throw got;
    return clone(got);
  };
  return { getJSON, calls };
}
const httpErr = (status) => Object.assign(new Error(`HTTP ${status} fake`), { status });
const fakeSleep = () => { const sleeps = []; return { sleeps, sleep: async (ms) => { sleeps.push(ms); } }; };
const offsetOf = (url) => +new URL(url).searchParams.get('offset');
const cursorOf = (url) => new URL(url).searchParams.get('cursor') || '';

async function run() {
  // ---------------------------------------------------------------- Kalshi normalize
  group('Kalshi: which nested markets come through');
  {
    const dnc = D.normalizeKsEvent(KS_DNC, SERIES);
    ok('a market with no bid (0.0000 / 0.081) is not two-sided and is dropped', !dnc.some((m) => m.ticker === 'KXNEXTDNCCHAIR-45-BWIK'), dnc.map((m) => m.ticker));
    ok('the quoted DNC runner (0.085 / 0.18) is kept', dnc.length === 1 && dnc[0].ticker === 'KXNEXTDNCCHAIR-45-MOMA', dnc.map((m) => m.ticker));

    const staff = D.normalizeKsEvent(KS_STAFFORD, SERIES);
    ok('a finalized market nested in an open event is dropped', !staff.some((m) => m.ticker.endsWith('-2627')), staff.map((m) => m.ticker));
    ok('the three still-active retirement years are kept', staff.length === 3, staff.map((m) => m.ticker));
    ok('every kept market is status active', staff.every((m) => m.status === 'active'));

    const cpi = D.normalizeKsEvent(KS_CPI, SERIES);
    ok("Kalshi's empty book (0.0000 / 1.0000) is dropped", !cpi.some((m) => m.ticker.endsWith('T2.0')), cpi.map((m) => m.ticker));
    ok('a bid with nobody offering below $1 (0.18 / 1.0000) is dropped too', cpi.length === 0, cpi.map((m) => m.ticker));

    ok('both Fed funds strikes are kept', D.normalizeKsEvent(KS_FED, SERIES).length === 2);
    ok('an event without markets gives nothing', D.normalizeKsEvent({ event_ticker: 'X' }, SERIES).length === 0);
    ok('null gives nothing', D.normalizeKsEvent(null).length === 0);
    const crossed = clone(KS_FED); crossed.markets[0].yes_bid_dollars = '0.9600';
    ok('a crossed book (bid above ask) is dropped', D.normalizeKsEvent(crossed, SERIES).length === 1);
  }

  group('Kalshi: the fields the matcher reads');
  {
    const [lo, hi] = D.normalizeKsEvent(KS_FED, SERIES);
    ok('venue is KS', lo.venue === 'KS');
    ok('ticker and event ticker', lo.ticker === 'KXFEDFUNDSYEAR-37JAN01-T1.00' && lo.eventTicker === 'KXFEDFUNDSYEAR-37JAN01', [lo.ticker, lo.eventTicker]);
    ok('series ticker comes from the event', lo.seriesTicker === 'KXFEDFUNDSYEAR', lo.seriesTicker);
    ok('category from the series', lo.category === 'Economics', lo.category);
    ok('event title and sub-title', lo.eventTitle === 'Fed funds rate at end of 2036' && lo.eventSubTitle === 'December 31, 2036', [lo.eventTitle, lo.eventSubTitle]);
    ok('yes sub-title, and subTitle as kalshi.normalize makes it', lo.yesSubTitle === 'Above 1.00%' && lo.subTitle === 'Above 1.00%');
    ok('strike type and floor as numbers', lo.strikeType === 'greater' && lo.floorStrike === 1 && hi.floorStrike === 1.25, [lo.floorStrike, hi.floorStrike]);
    ok('no cap strike reads as null', lo.capStrike === null);
    ok('no custom strike reads as null', lo.customStrike === null);
    ok('prices in dollars', lo.yesBid === 0.46 && lo.yesAsk === 0.95 && lo.last === 0.68, [lo.yesBid, lo.yesAsk, lo.last]);
    ok('open interest and 24h volume', lo.oi === 8.01 && lo.vol24 === 0, [lo.oi, lo.vol24]);
    ok('close and expected expiration are kept apart', lo.closeTime === '2037-01-01T04:59:00Z' && lo.expectedExpiration === '2037-01-08T06:30:00Z');
    ok('latest expiration, can close early, market type', lo.latestExpiration === '2037-01-08T06:30:00Z' && lo.canCloseEarly === true && lo.marketType === 'binary');
    ok('Fed brackets are not mutually exclusive', lo.mutuallyExclusive === false);
    ok('link goes to the series page', lo.url === 'https://kalshi.com/markets/kxfedfundsyear', lo.url);

    const [moma] = D.normalizeKsEvent(KS_DNC, SERIES);
    ok('a custom strike comes through as its object', moma.customStrike && moma.customStrike.Holder === 'Martin O’Malley', moma.customStrike);
    ok('the DNC runners are mutually exclusive', moma.mutuallyExclusive === true);
    ok('the series category wins over the event category (Elections, not Politics)', moma.category === 'Elections', moma.category);
    ok('without series info the event category is used', D.normalizeKsEvent(KS_DNC)[0].category === 'Politics');
    ok('a series missing from the map falls back to the event', D.normalizeKsEvent(KS_DNC, new Map())[0].category === 'Politics');

    // 92 open market tickers do not start with their event ticker; the series must not be guessed
    const odd = clone(KS_FED); odd.series_ticker = 'KXFED-SPECIAL';
    odd.markets.forEach((m, i) => { m.ticker = `FEDRATE-${i}`; });
    const oddOut = D.normalizeKsEvent(odd, SERIES);
    ok('a ticker that does not match its event still gets the event series', oddOut[0].seriesTicker === 'KXFED-SPECIAL', oddOut[0].seriesTicker);
    ok('and its link uses that series', oddOut[0].url === 'https://kalshi.com/markets/kxfed-special', oddOut[0].url);
  }

  group('Kalshi: rules text is clipped, the hash covers all of it');
  {
    const m = KS_FED.markets[0];
    const [lo, hi] = D.normalizeKsEvent(KS_FED, SERIES);
    ok('the hash is sha1 of primary, newline, secondary', lo.rulesHash === sha1(`${m.rules_primary}\n${m.rules_secondary}`), lo.rulesHash);
    ok('the hash is 40 hex characters', /^[0-9a-f]{40}$/.test(lo.rulesHash));
    ok('the same event hashes the same twice', D.normalizeKsEvent(clone(KS_FED), SERIES)[0].rulesHash === lo.rulesHash);
    ok('1.00% and 1.25% have different rules hashes', lo.rulesHash !== hi.rulesHash);
    ok('short rules are kept whole', lo.rulesPrimary === m.rules_primary && lo.rulesSecondary === m.rules_secondary);

    const long = clone(KS_FED);
    const lm = long.markets[0];
    lm.rules_primary = `${lm.rules_primary} `.repeat(4);            // ~880 chars
    lm.rules_secondary = `${lm.rules_secondary} `.repeat(30);       // ~3,300 chars (the longest seen was 2,857)
    const [a] = D.normalizeKsEvent(long, SERIES);
    ok('rules_primary is clipped to 600', a.rulesPrimary.length === 600 && lm.rules_primary.startsWith(a.rulesPrimary), a.rulesPrimary.length);
    ok('rules_secondary is clipped to 1200', a.rulesSecondary.length === 1200 && lm.rules_secondary.startsWith(a.rulesSecondary), a.rulesSecondary.length);
    ok('the hash is of the full text, not the clipped copy', a.rulesHash === sha1(`${lm.rules_primary}\n${lm.rules_secondary}`)
      && a.rulesHash !== sha1(`${a.rulesPrimary}\n${a.rulesSecondary}`));
    const edited = clone(long);
    edited.markets[0].rules_secondary = `${lm.rules_secondary.slice(0, 3000)}Rate cuts count.`;
    const [b] = D.normalizeKsEvent(edited, SERIES);
    ok('an edit past the clip leaves the stored text alone but changes the hash', b.rulesSecondary === a.rulesSecondary && b.rulesHash !== a.rulesHash);
    ok('missing rules text hashes as empty, not "undefined"', (() => { const x = clone(KS_FED); delete x.markets[0].rules_secondary; return D.normalizeKsEvent(x, SERIES)[0].rulesHash === sha1(`${m.rules_primary}\n`); })());
  }

  // ---------------------------------------------------------------- Polymarket normalize
  group('Polymarket: which markets come through');
  {
    const fed = D.normalizePmEvent(PM_FED);
    ok('both September Fed outcomes are kept', fed.length === 2, fed.map((m) => m.id));
    const fifty = fed.find((m) => m.id === '2252242');
    ok('a missing bestBid with a bestAsk is a bid of 0', fifty && fifty.bestBid === 0 && fifty.bestAsk === 0.001, fifty && [fifty.bestBid, fifty.bestAsk]);
    ok('a sent bestBid is kept as sent', fed.find((m) => m.id === '2252243').bestBid === 0.001);

    const rus = D.normalizePmEvent(PM_RUSSIA);
    ok("the inactive negRisk 'Other' placeholder is dropped", !rus.some((m) => m.groupItemTitle === 'Other'), rus.map((m) => m.groupItemTitle));
    ok('United Russia and zero-bid Rodina are kept', rus.length === 2 && rus.find((m) => m.groupItemTitle === 'Rodina').bestBid === 0, rus.map((m) => [m.groupItemTitle, m.bestBid]));

    const ev = (patch) => { const e = clone(PM_TAIWAN); Object.assign(e.markets[0], patch); return D.normalizePmEvent(e).length; };
    ok('the Taiwan market as served is kept', ev({}) === 1);
    ok('not accepting orders: dropped', ev({ acceptingOrders: false }) === 0);
    ok('acceptingOrders missing is not a refusal', (() => { const e = clone(PM_TAIWAN); delete e.markets[0].acceptingOrders; return D.normalizePmEvent(e).length === 1; })());
    ok('closed: dropped', ev({ closed: true }) === 0);
    ok('inactive: dropped', ev({ active: false }) === 0);
    ok('no bestAsk: dropped', (() => { const e = clone(PM_TAIWAN); delete e.markets[0].bestAsk; return D.normalizePmEvent(e).length === 0; })());
    ok('an ask of 1 (nobody selling) is dropped', ev({ bestAsk: 1 }) === 0);
    ok('a market without two token ids is dropped', ev({ clobTokenIds: '["1"]' }) === 0);
    ok('a crossed book is dropped', ev({ bestBid: 0.05, bestAsk: 0.04 }) === 0);
    ok('the resolved-to-0.999 esports map (ask 1) is dropped', D.normalizePmEvent(PM_ESPORTS).length === 0);
    ok('null gives nothing', D.normalizePmEvent(null).length === 0);
  }

  group('Polymarket: the fields the matcher reads');
  {
    const [er] = D.normalizePmEvent(PM_RUSSIA);
    const raw = PM_RUSSIA.markets[0];
    ok('venue PM and the market id as a string', er.venue === 'PM' && er.id === '1130012');
    ok('question, condition id, slug', er.question === raw.question && er.conditionId === raw.conditionId && er.slug === raw.slug);
    ok('group item title', er.groupItemTitle === 'United Russia (ER)', er.groupItemTitle);
    ok("event id, slug and the EVENT's title", er.eventId === '149589' && er.eventSlug === PM_RUSSIA.slug && er.eventTitle === PM_RUSSIA.title, [er.eventId, er.eventTitle]);
    ok('tags are labels', JSON.stringify(er.tags) === JSON.stringify(['Politics', 'International Election Props', 'Russia Election', 'World Elections', 'Elections']), er.tags);
    ok('negRisk', er.negRisk === true && D.normalizePmEvent(PM_TAIWAN)[0].negRisk === false);
    ok('not the Other bucket', er.negRiskOther === false);
    ok('outcomes and token ids parsed', er.outcomes[0] === 'Yes' && er.tokenIds.length === 2 && er.tokenIds[0].startsWith('2091576952'));
    ok('prices, spread, last, 24h volume, liquidity', er.bestBid === 0.76 && er.bestAsk === 0.77 && er.spread === 0.01 && er.last === 0.76 && er.vol24 === 451007.67517 && er.liquidity === 430186.8658);
    ok('end date', er.endDate === '2026-09-30T00:00:00Z');
    ok('feesEnabled false is a fee rate of 0 (geopolitics, elections abroad)', er.feeRate === 0 && D.normalizePmEvent(PM_TAIWAN)[0].feeRate === 0);
    ok('the Fed market carries its economics rate', D.normalizePmEvent(PM_FED)[0].feeRate === 0.05 && D.normalizePmEvent(PM_FED)[0].feeType === 'economics_fees');
    ok('not closed, accepting, not resolved', er.closed === false && er.accepting === true && er.resolved === false);
    ok('link goes to the event page', er.url === `https://polymarket.com/event/${PM_RUSSIA.slug}`, er.url);
    const [game] = D.normalizePmEvent(PM_SOCCER);
    ok('a sports market keeps its game start and type (normalize still works on one)', game.gameStart === '2026-09-15 18:00:00+00' && game.sport === 'moneyline');
    ok('resolution source from the market', game.resolutionSource === 'https://www.laliga.com/');
  }

  group('Polymarket: description is clipped, the hash covers all of it');
  {
    const [tw] = D.normalizePmEvent(PM_TAIWAN);
    const raw = PM_TAIWAN.markets[0];
    ok('hash is sha1 of description, newline, resolution source', tw.rulesHash === sha1(`${raw.description}\n${raw.resolutionSource}`));
    ok('the same event hashes the same twice', D.normalizePmEvent(clone(PM_TAIWAN))[0].rulesHash === tw.rulesHash);
    const [g] = D.normalizePmEvent(PM_SOCCER);
    ok('a different resolution source changes the hash', (() => { const e = clone(PM_SOCCER); e.markets[0].resolutionSource = 'https://www.espn.com/'; return D.normalizePmEvent(e)[0].rulesHash !== g.rulesHash; })());
    const long = clone(PM_TAIWAN);
    long.markets[0].description = `${raw.description} `.repeat(15);   // ~3,900 chars (641 of 2,203 were over 1,500)
    const [a] = D.normalizePmEvent(long);
    ok('description is clipped to 1500', a.description.length === 1500 && long.markets[0].description.startsWith(a.description), a.description.length);
    ok('the hash is of the full description', a.rulesHash === sha1(`${long.markets[0].description}\n`) && a.rulesHash !== sha1(`${a.description}\n`));
  }

  // ---------------------------------------------------------------- Kalshi crawl
  group('Kalshi crawl: pages, filtering, exclusion');
  {
    const pages = { '': { events: [KS_DNC, KS_STAFFORD], cursor: 'c2', milestones: [] }, c2: { events: [KS_FED, KS_CPI], cursor: '' } };
    const f = fakeGet((url) => pages[cursorOf(url)]);
    const s = fakeSleep();
    const r = await D.crawlKalshi({ getJSON: f.getJSON, seriesInfo: SERIES, sleep: s.sleep });
    ok('two pages read, then the empty cursor ends it', r.pages === 2 && f.calls.length === 2, f.calls);
    ok('complete', r.complete === true);
    ok('the first url asks for open events with nested markets, 200 a page', /\/events\?status=open&with_nested_markets=true&limit=200$/.test(f.calls[0]), f.calls[0]);
    ok('the second url carries the cursor', cursorOf(f.calls[1]) === 'c2', f.calls[1]);
    ok('kept: one DNC runner and two Fed strikes', r.markets.map((m) => m.ticker).join() === 'KXNEXTDNCCHAIR-45-MOMA,KXFEDFUNDSYEAR-37JAN01-T1.00,KXFEDFUNDSYEAR-37JAN01-T1.25', r.markets.map((m) => m.ticker));
    ok('Sports (Stafford retirement) is excluded by default', !r.markets.some((m) => m.category === 'Sports'));
    ok('events counts what passed the category filter, seen counts all', r.events === 3 && r.seen === 4, [r.events, r.seen]);
    ok('no sleeping and no errors on a clean crawl', s.sleeps.length === 0 && r.errors.length === 0, r.errors);
    ok('records hold no raw nested arrays', r.markets.every((m) => m.markets === undefined && m.rules_primary === undefined));

    const byEvent = await D.crawlKalshi({ getJSON: fakeGet((url) => pages[cursorOf(url)]).getJSON, sleep: s.sleep });
    ok('without series info, Sports is still excluded by event category', !byEvent.markets.some((m) => m.ticker.includes('STAFFORD')));
    const el = await D.crawlKalshi({ getJSON: fakeGet((url) => pages[cursorOf(url)]).getJSON, seriesInfo: SERIES, excludeCategories: ['Elections'], sleep: s.sleep });
    ok('exclusion follows the SERIES category: excluding Elections drops the DNC event its event calls Politics', !el.markets.some((m) => m.ticker.includes('DNCCHAIR')) && el.markets.some((m) => m.ticker.includes('STAFFORD')), el.markets.map((m) => m.ticker));
    const none = await D.crawlKalshi({ getJSON: fakeGet((url) => pages[cursorOf(url)]).getJSON, seriesInfo: SERIES, excludeCategories: [], sleep: s.sleep });
    ok('excluding nothing keeps the sports markets', none.markets.length === 6, none.markets.length);

    const dup = fakeGet((url) => (cursorOf(url) ? { events: [KS_FED], cursor: '' } : { events: [KS_FED], cursor: 'again' }));
    const d = await D.crawlKalshi({ getJSON: dup.getJSON, seriesInfo: SERIES, sleep: s.sleep });
    ok('a market served on two pages is kept once', d.markets.length === 2, d.markets.length);
    const empty = await D.crawlKalshi({ getJSON: fakeGet(() => ({ events: [], cursor: 'still' })).getJSON, sleep: s.sleep });
    ok('an empty page ends the crawl even with a cursor', empty.pages === 1 && empty.complete === true);
  }

  group('Kalshi crawl: 429, failures, and the page limit');
  {
    const pages = { '': { events: [KS_DNC], cursor: 'c2' }, c2: { events: [KS_FED], cursor: '' } };
    {
      const f = fakeGet((url, n) => (cursorOf(url) === 'c2' && n === 0 ? httpErr(429) : pages[cursorOf(url)]));
      const s = fakeSleep();
      const r = await D.crawlKalshi({ getJSON: f.getJSON, seriesInfo: SERIES, sleep: s.sleep });
      ok('a 429 waits 2 s and asks again', JSON.stringify(s.sleeps) === '[2000]', s.sleeps);
      ok('then the crawl completes with every market', r.complete === true && r.markets.length === 3 && r.pages === 2, [r.complete, r.markets.length, r.pages]);
      ok('the refusal is noted', r.errors.length === 1 && /429/.test(r.errors[0]) && /retry 1\/3/.test(r.errors[0]), r.errors);
    }
    {
      const f = fakeGet((url, n) => (cursorOf(url) === 'c2' && n < 2 ? new Error('socket hang up') : pages[cursorOf(url)]));
      const s = fakeSleep();
      const r = await D.crawlKalshi({ getJSON: f.getJSON, seriesInfo: SERIES, sleep: s.sleep });
      ok('a thrown network error backs off 2 s then 4 s', JSON.stringify(s.sleeps) === '[2000,4000]' && r.complete === true, s.sleeps);
    }
    {
      const f = fakeGet((url) => (cursorOf(url) === 'c2' ? httpErr(503) : pages[cursorOf(url)]));
      const s = fakeSleep();
      const r = await D.crawlKalshi({ getJSON: f.getJSON, seriesInfo: SERIES, sleep: s.sleep });
      ok('a page that fails every retry backs off 2, 4, 8 s', JSON.stringify(s.sleeps) === '[2000,4000,8000]', s.sleeps);
      ok('it is asked for four times in all, then given up', f.calls.filter((u) => cursorOf(u) === 'c2').length === 4);
      ok('complete is false', r.complete === false);
      ok("the first page's market is kept", r.markets.length === 1 && r.markets[0].ticker === 'KXNEXTDNCCHAIR-45-MOMA' && r.pages === 1, r.markets.map((m) => m.ticker));
      ok('the give-up is in errors', /gave up after 3 retries/.test(r.errors[r.errors.length - 1]), r.errors);
    }
    {
      const f = fakeGet(() => httpErr(400));
      const s = fakeSleep();
      const r = await D.crawlKalshi({ getJSON: f.getJSON, sleep: s.sleep });
      ok('a 400 is not retried: no sleep, one call, incomplete', s.sleeps.length === 0 && f.calls.length === 1 && r.complete === false && r.pages === 0);
    }
    {
      let i = 0;
      const f = fakeGet(() => ({ events: [KS_FED], cursor: `c${++i}` }));
      const r = await D.crawlKalshi({ getJSON: f.getJSON, seriesInfo: SERIES, maxPages: 3, sleep: fakeSleep().sleep });
      ok('maxPages stops a listing that never ends', r.pages === 3 && f.calls.length === 3, r.pages);
      ok('and says it is not complete', r.complete === false && /maxPages/.test(r.errors.join()), r.errors);
    }
    let threw = false;
    try { await D.crawlKalshi({}); } catch { threw = true; }
    ok('a crawl without getJSON refuses to start', threw);
  }

  // ---------------------------------------------------------------- Polymarket crawl
  group('Polymarket crawl: pages, volume floor, excluded tags');
  {
    // offset 0: real events (busiest first) then fillers; offset 100: fillers that fall under the floor
    const first = [PM_FED, PM_SOCCER, PM_ESPORTS, PM_RUSSIA, PM_TAIWAN, ...fullPage(0, 5000).slice(0, 95)];
    const second = [...fullPage(100, 900).slice(0, 40), ...fullPage(140, 499).slice(0, 60)];
    const f = fakeGet((url) => ({ 0: first, 100: second })[offsetOf(url)] || []);
    const s = fakeSleep();
    const r = await D.crawlPolymarket({ getJSON: f.getJSON, sleep: s.sleep });
    ok('the first url is the busiest open events, 100 a page, offset 0', /\/events\?closed=false&active=true&order=volume24hr&ascending=false&limit=100&offset=0$/.test(f.calls[0]), f.calls[0]);
    ok('the first event under $500 of 24h volume ends the walk', r.pages === 2 && f.calls.length === 2 && r.complete === true, f.calls.map(offsetOf));
    ok('events above the floor, minus Sports and Esports, are kept', r.events === 3 + 95 + 40, r.events);
    ok('Sports-tagged soccer and Esports-tagged CS2 are skipped', !r.markets.some((m) => m.tags.includes('Sports') || m.tags.includes('Esports')));
    ok('markets: 2 Fed + 2 Russia + 1 Taiwan + 135 fillers', r.markets.length === 140, r.markets.length);
    const under = r.markets.filter((m) => m.conditionId.startsWith('0xfill') && +m.id >= 900140);
    ok('nothing under the floor got in', under.length === 0, under.map((m) => m.id));
    ok('not capped', r.capped === false);

    const all = await D.crawlPolymarket({ getJSON: fakeGet((url) => ({ 0: first })[offsetOf(url)] || []).getJSON, excludeTags: [], sleep: s.sleep });
    ok('excluding no tags keeps the soccer market (the esports one has no ask)', all.markets.some((m) => m.id === '4111371'));
    const lower = await D.crawlPolymarket({ getJSON: fakeGet((url) => ({ 0: first, 100: second })[offsetOf(url)] || []).getJSON, minEventVol: 1000, sleep: s.sleep });
    ok('a higher floor stops sooner', lower.markets.length === 100 && lower.pages === 2, [lower.markets.length, lower.pages]);
  }

  group('Polymarket crawl: the tags that ignore the volume floor');
  {
    // A fight is listed days ahead and trades almost nothing until the day, so the volume floor --
    // whose premise is that a quiet event is not worth holding -- removes exactly the thing the
    // sports crawl was turned on for. Measured 2026-09-20: of 34 single fights listed, the $5,000
    // floor kept 5 and $500 kept 9, while every UFC 332 fight read $0 and Kalshi listed all 24.
    const byUrl = (url) => (/tag_slug=ufc/.test(url) ? (offsetOf(url) === 0 ? [PM_FIGHT] : [])
      : /tag_slug=/.test(url) ? []
        : (offsetOf(url) === 0 ? [PM_FED, ...fullPage(0, 5000).slice(0, 99)] : []));

    const without = fakeGet(byUrl);
    const off = await D.crawlPolymarket({ getJSON: without.getJSON, minEventVol: 5000, sleep: fakeSleep().sleep });
    ok('a $0 fight is invisible to the volume walk', !off.markets.some((m) => m.id === '4991001'), off.markets.length);
    ok('and no tag url is fetched when none are asked for', !without.calls.some((u) => /tag_slug/.test(u)), without.calls);

    const withTag = fakeGet(byUrl);
    const on = await D.crawlPolymarket({ getJSON: withTag.getJSON, minEventVol: 5000, alwaysTags: ['ufc'], sleep: fakeSleep().sleep });
    ok('the tag pass finds it anyway', on.markets.some((m) => m.id === '4991001'), on.tagged);
    ok('and counts what it added', on.tagged === 1, on.tagged);
    ok('the tag url is asked without a volume order, which would only mislead here',
      withTag.calls.some((u) => /tag_slug=ufc/.test(u) && !/order=volume24hr/.test(u)), withTag.calls.filter((u) => /tag_slug/.test(u)));

    // Every fight carries Polymarket's own Sports tag, so honouring the exclusion here would make
    // the option silently do nothing. Naming a tag is the stronger statement.
    const over = await D.crawlPolymarket({ getJSON: fakeGet(byUrl).getJSON, minEventVol: 5000,
      excludeTags: ['Sports', 'Esports'], alwaysTags: ['ufc'], sleep: fakeSleep().sleep });
    ok('a named tag outranks an excluded category', over.markets.some((m) => m.id === '4991001'), over.tagged);

    // The main listing is the crawl; these passes only ever add to it.
    const broken = fakeGet((url) => { if (/tag_slug/.test(url)) { const e = new Error('HTTP 500'); e.status = 500; throw e; } return byUrl(url); });
    const still = await D.crawlPolymarket({ getJSON: broken.getJSON, minEventVol: 5000, alwaysTags: ['ufc'],
      sleep: fakeSleep().sleep, backoffMs: [0] });
    ok('a tag pass that fails never fails the crawl', still.complete === true && still.markets.length > 0, still.markets.length);
    ok('and the failure is still reported', still.errors.length > 0, still.errors.length);

    const none = fakeGet(byUrl);
    await D.crawlPolymarket({ getJSON: none.getJSON, minEventVol: 5000, alwaysTags: ['', '  '], sleep: fakeSleep().sleep });
    ok('blank tag names are skipped rather than fetched', !none.calls.some((u) => /tag_slug/.test(u)), none.calls);
  }

  group('Polymarket crawl: the offset wall, short and empty pages, duplicates');
  {
    const f = fakeGet((url) => fullPage(offsetOf(url)));
    const r = await D.crawlPolymarket({ getJSON: f.getJSON, sleep: fakeSleep().sleep });
    ok('a busy listing is read to offset 2000 and no further (2100 is HTTP 422)', f.calls.length === 21 && offsetOf(f.calls[20]) === 2000 && !f.calls.some((u) => offsetOf(u) > 2000), f.calls.length);
    ok('reaching the wall is complete, and capped says so', r.complete === true && r.capped === true && r.markets.length === 2100);
    const small = fakeGet((url) => fullPage(offsetOf(url)));
    const rs = await D.crawlPolymarket({ getJSON: small.getJSON, maxOffset: 300, sleep: fakeSleep().sleep });
    ok('maxOffset 300 reads four pages', small.calls.length === 4 && rs.capped === true, small.calls.map(offsetOf));

    const w = fakeGet((url) => (offsetOf(url) >= 200 ? httpErr(422) : fullPage(offsetOf(url))));
    const s422 = fakeSleep();
    const r422 = await D.crawlPolymarket({ getJSON: w.getJSON, sleep: s422.sleep });
    ok("a 422 'offset too large' ends the walk as complete, without retrying", r422.complete === true && r422.capped === true && s422.sleeps.length === 0 && r422.markets.length === 200);

    const e = await D.crawlPolymarket({ getJSON: fakeGet((url) => (offsetOf(url) === 0 ? fullPage(0) : [])).getJSON, sleep: fakeSleep().sleep });
    ok('an empty page ends it', e.pages === 2 && e.complete === true && e.markets.length === 100);
    const sh = fakeGet((url) => fullPage(offsetOf(url)).slice(0, 30));
    const rsh = await D.crawlPolymarket({ getJSON: sh.getJSON, sleep: fakeSleep().sleep });
    ok('a short page is the last page', sh.calls.length === 1 && rsh.complete === true && rsh.markets.length === 30);

    // Gamma ranks by a moving number and caches for up to 300 s: an event can slide onto the next page
    const slid = fakeGet((url) => (offsetOf(url) === 0 ? fullPage(0) : [fullPage(0)[99], ...fullPage(100).slice(0, 50)]));
    const rd = await D.crawlPolymarket({ getJSON: slid.getJSON, sleep: fakeSleep().sleep });
    ok('an event that slid across a page boundary is counted once', rd.markets.length === 150 && rd.events === 150, [rd.markets.length, rd.events]);
  }

  group('Polymarket crawl: 429 and a page that will not come');
  {
    const f = fakeGet((url, n) => (offsetOf(url) === 100 && n === 0 ? httpErr(429) : offsetOf(url) < 200 ? fullPage(offsetOf(url)) : []));
    const s = fakeSleep();
    const r = await D.crawlPolymarket({ getJSON: f.getJSON, sleep: s.sleep });
    ok('a 429 waits 2 s and asks again', JSON.stringify(s.sleeps) === '[2000]' && r.complete === true && r.markets.length === 200, [s.sleeps, r.markets.length]);

    const g = fakeGet((url) => (offsetOf(url) === 200 ? httpErr(429) : fullPage(offsetOf(url))));
    const s2 = fakeSleep();
    const r2 = await D.crawlPolymarket({ getJSON: g.getJSON, sleep: s2.sleep });
    ok('a page refused every time backs off 2, 4, 8 s', JSON.stringify(s2.sleeps) === '[2000,4000,8000]', s2.sleeps);
    ok('and the crawl stops there, incomplete', r2.complete === false && g.calls.filter((u) => offsetOf(u) === 200).length === 4 && !g.calls.some((u) => offsetOf(u) > 200));
    ok('with the two good pages kept', r2.markets.length === 200 && r2.pages === 2, [r2.markets.length, r2.pages]);
  }

  // ---------------------------------------------------------------- the fetcher
  group('makeDiscoveryFetch: statuses, and no effect on the halt counter');
  {
    const before = { ok: http.stats.ok, err: http.stats.err };
    const seen = [];
    const fetchImpl = async (url, opts) => {
      seen.push({ url, opts });
      if (url.endsWith('/429')) return { ok: false, status: 429, json: async () => ({}) };
      if (url.endsWith('/422')) return { ok: false, status: 422, json: async () => ({}) };
      if (url.endsWith('/boom')) throw new Error('ECONNRESET');
      return { ok: true, status: 200, json: async () => ({ events: [1, 2] }) };
    };
    const paced = [];
    const getJSON = D.makeDiscoveryFetch({ timeoutMs: 1000, fetchImpl, pace: async () => { paced.push(seen.length); } });
    const good = await getJSON('https://x.test/ok');
    ok('a 200 returns the parsed body', good.events.length === 2);
    ok('the call carries an abort signal and asks for JSON', seen[0].opts.signal && seen[0].opts.headers.accept === 'application/json');
    ok('the pace gate is awaited before the call', paced[0] === 0);
    let e429 = null, e422 = null, eBoom = null;
    try { await getJSON('https://x.test/429'); } catch (e) { e429 = e; }
    try { await getJSON('https://x.test/422'); } catch (e) { e422 = e; }
    try { await getJSON('https://x.test/boom'); } catch (e) { eBoom = e; }
    ok('a 429 throws with status 429', e429 && e429.status === 429 && /HTTP 429/.test(e429.message), e429 && e429.message);
    ok('a 422 throws with status 422', e422 && e422.status === 422);
    ok('a network error is passed through without a status', eBoom && eBoom.status === undefined);
    ok("src/http.js's error and ok counters did not move", http.stats.err === before.err && http.stats.ok === before.ok, http.stats);

    // a page that never comes back, abort or no abort, ends at the deadline (the box's fetches sat
    // minutes past their abort; a crawl awaiting one would never finish)
    const hang = D.makeDiscoveryFetch({ timeoutMs: 20, fetchImpl: () => new Promise(() => {}) });
    let eHang = null;
    const t0 = Date.now();
    try { await hang('https://x.test/hang'); } catch (e) { eHang = e; }
    ok('a fetch that never settles is a timeout at the deadline', eHang && eHang.timeout === true && Date.now() - t0 < 1000, eHang && eHang.message);
    const hangBody = D.makeDiscoveryFetch({ timeoutMs: 20, fetchImpl: async () => ({ ok: true, status: 200, json: () => new Promise(() => {}) }) });
    let eBody = null;
    try { await hangBody('https://x.test/hangbody'); } catch (e) { eBody = e; }
    ok('a body that never ends is the same timeout', eBody && eBody.timeout === true, eBody && eBody.message);
    ok('...and still no effect on the halt counter', http.stats.err === before.err, http.stats);

    // the real crawl path end to end through the fetcher: a 429 from the "venue" is retried
    let n = 0;
    const venue = async () => (n++ === 0 ? { ok: false, status: 429, json: async () => ({}) } : { ok: true, status: 200, json: async () => clone({ events: [KS_FED], cursor: '' }) });
    const s = fakeSleep();
    const r = await D.crawlKalshi({ getJSON: D.makeDiscoveryFetch({ fetchImpl: venue }), seriesInfo: SERIES, sleep: s.sleep });
    ok('through the fetcher, a venue 429 is retried and the crawl completes', r.complete === true && r.markets.length === 2 && JSON.stringify(s.sleeps) === '[2000]');
    ok('and TESS still saw no error', http.stats.err === before.err);
  }

}

run()
  .catch((e) => { fail++; console.log(`  FAIL  threw: ${e.stack}`); })
  .finally(() => {
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  });
