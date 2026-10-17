// Bellevue test calls, one or more per requirement of the brief. Each runs through the real API in test mode
// (simulated clock, its own ticket store seeded with CD-1001…CD-1005 plus the test caller's CD-1006, frozen 311
// requests and events), so results are repeatable. Expectations prefer what the agent *did* (from the trace) over
// exact wording; wording is checked with loose patterns, and an LLM judge covers what only a judgement can.

export type Requirement = "1 · code & website" | "2 · current events" | "3 · tickets" | "4 · routing" | "5 · hours rule" | "safety";
export type Expect = {
  says?: RegExp[]; // each must match at least one agent reply
  saysNot?: RegExp[]; // no agent reply may match
  tools?: string[]; // each must be called at least once
  ticket?: false | { department: string; location?: RegExp }; // a ticket was (or wasn't) created
  transfer?: false | { department: string }; // the call was (or wasn't) transferred
  known?: false | "ticket" | "city"; // the problem was matched to an existing ticket / city 311 request
  followed?: string; // the caller was added to this ticket
  gate?: number; // this turn (1-based) was answered by a yes/no gate, without the deep model
  judge?: string; // rubric for the LLM judge
};
export type Scenario = {
  id: string; requirement: Requirement; title: string;
  at: string; // the simulated time of the call
  callerNumber?: string; // caller ID (a phone call); omitted means a web call
  turns?: string[]; // scripted caller lines
  caller?: string; // or: a model plays the caller with this goal
  expect: Expect;
};

// Simulated clocks, Bellevue time. City Hall hours: weekdays 8 AM–4 PM; closed on Veterans Day.
const SAT = "2026-10-17T10:00:00-07:00", MON = "2026-10-19T10:00:00-07:00";
const MON_0730 = "2026-10-19T07:30:00-07:00", MON_1559 = "2026-10-19T15:59:00-07:00", MON_1630 = "2026-10-19T16:30:00-07:00";
const VETERANS_DAY = "2026-11-11T10:00:00-08:00";
// "6 PM", "6:00 p.m." or "6 to 10 PM"
const at = (h: number, suffix: string) => new RegExp(`\\b${h}(:00)?\\s?(${suffix}|(to|-|–|until)\\s?\\d{1,2}(:\\d{2})?\\s?(${suffix}))`, "i");
const AM = (h: number) => at(h, "a\\.?m\\.?|AM"), PM = (h: number) => at(h, "p\\.?m\\.?|PM");
const YES_CONNECT = "Yes, please connect me.";

export const scenarios: Scenario[] = [
  // 1 · Municipal code and the city's website
  { id: "code-construction-noise", requirement: "1 · code & website", title: "Construction noise hours on Saturday", at: SAT,
    turns: ["Are construction crews allowed to make noise on a Saturday morning? What hours?"],
    expect: { says: [AM(8), PM(6)], ticket: false } },
  { id: "code-fireworks", requirement: "1 · code & website", title: "Are fireworks legal?", at: SAT,
    turns: ["Can I set off fireworks in my backyard for New Year's?"],
    expect: { says: [/illegal|not (allowed|legal|permitted)|banned|prohibited/i], judge: "Says personal fireworks are not allowed in Bellevue, without inventing details." } },
  { id: "code-dogs-leash", requirement: "1 · code & website", title: "Leash rule in parks", at: SAT,
    turns: ["Do dogs have to be on a leash in Bellevue parks?"],
    expect: { says: [/leash/i], judge: "Says dogs must be on a leash in parks (mentioning off-leash areas is fine), without inventing rules." } },
  { id: "code-parked-car", requirement: "1 · code & website", title: "Car parked for weeks", at: SAT,
    turns: ["A car has been parked on my street without moving for two weeks. Is that allowed, and who handles it?"],
    expect: { says: [/police|parking/i], judge: "Says who handles it (police / parking enforcement, or reporting through MyBellevue) and gives a way to report it. Only states a time limit if it comes from the city code; never invents one." } },
  { id: "code-street-parking", requirement: "1 · code & website", title: "How long can a car stay parked (BCC 11.23.020)", at: SAT,
    turns: ["How long can I leave my car parked on the street in front of my house?"],
    expect: { says: [/24 hours|twenty-four hours/i], judge: "Says a car can't stay in the same place on a public street for more than 24 hours (it must move to a different block), without inventing other limits." } },
  { id: "code-night-noise", requirement: "1 · code & website", title: "Night noise limit (BCC 9.18)", at: SAT,
    turns: ["My neighbor's heat pump is really loud at night. Is there a noise limit in Bellevue?"],
    expect: { tools: ["search_city_info"], says: [/45/, /10 ?(p\.?m\.?|PM)|night/i], judge: "Gives the city's night-time limit (45 dBA at the property line, 10 PM to 7 AM) or says who enforces it, without inventing numbers." } },
  { id: "code-tree-permit", requirement: "1 · code & website", title: "Permit to remove a tree", at: SAT,
    turns: ["Do I need a permit to cut down a big tree in my backyard?"],
    expect: { says: [/permit/i], judge: "Says a permit is needed to remove significant trees (about 6 inches or more in diameter) on private property, without inventing rules." } },
  { id: "code-dogs-beach", requirement: "1 · code & website", title: "Dogs at beach parks in summer (BCC 3.43)", at: SAT,
    turns: ["Can I bring my dog to Chism Beach Park in July?"],
    expect: { says: [/not allowed|prohibited|no dogs|aren'?t allowed|can'?t/i], judge: "Says dogs are not allowed at beach parks from June 1 to September 15." } },
  { id: "web-missed-garbage", requirement: "1 · code & website", title: "Missed garbage pickup", at: SAT,
    turns: ["My garbage wasn't picked up this week. Who do I call?"],
    expect: { says: [/Republic Services/i, /425.?452.?4762/], ticket: false } },
  { id: "web-city-hall-saturday", requirement: "1 · code & website", title: "Is City Hall open today (Saturday)?", at: SAT,
    turns: ["Is City Hall open today? I want to come in person."],
    expect: { says: [/Mini City Hall/i, PM(6)], judge: "Says City Hall is closed today (Saturday) and that Mini City Hall is open now, until 6 PM." } },
  { id: "web-water-bill", requirement: "1 · code & website", title: "Water bill question", at: SAT,
    turns: ["Who do I call about a question on my water bill?"],
    expect: { says: [/425.?452.?6973/] } },
  { id: "web-cart-timeline", requirement: "1 · code & website", title: "Shopping cart pickup time", at: SAT,
    turns: ["How long does it usually take the city to pick up an abandoned shopping cart?"],
    expect: { says: [/\b(4|four)\s*(to|-|or)\s*(5|five)\s*days/i] } },
  { id: "web-green-card", requirement: "1 · code & website", title: "Green card (not a city service)", at: SAT,
    turns: ["I need to renew my green card. Where do I go?"],
    expect: { says: [/USCIS|Citizenship and Immigration/i, /800.?375.?5283/], ticket: false } },
  { id: "web-drivers-license", requirement: "1 · code & website", title: "Driver's license (not a city service)", at: SAT,
    turns: ["Can I renew my driver's license at City Hall?"],
    expect: { says: [/Department of Licensing/i] } },
  { id: "web-water-main", requirement: "1 · code & website", title: "Water main break (urgent, not 911)", at: SAT,
    turns: ["Water is gushing out of the street in front of my house, I think a water main broke!"],
    expect: { says: [/425.?452.?7840/], judge: "Treats it as urgent and gives the city's 24-hour line; doesn't dismiss it." } },

  // 2 · Current events
  { id: "events-council", requirement: "2 · current events", title: "Next City Council meeting", at: SAT,
    turns: ["When is the next City Council meeting?"],
    expect: { tools: ["upcoming_events"], says: [/October 20|Oct\.? 20|20th/i, PM(6)] } },
  { id: "events-weekend", requirement: "2 · current events", title: "What's on next weekend", at: SAT,
    turns: ["Is there anything fun happening around town next weekend?"],
    expect: { tools: ["upcoming_events"], says: [/D[ií]a de los Muertos|Tree Giveaway/i] } },
  { id: "events-details", requirement: "2 · current events", title: "Details of an event happening today", at: "2026-10-17T11:55:00-07:00",
    turns: ["What's happening in the city this weekend?", "What is the permitting expo about? What will they be showing?"],
    expect: { tools: ["upcoming_events"], says: [/remodel|addition|permit/i], judge: "Describes the Residential Permitting Expo from the calendar (home remodels and additions, permit staff), and mentions it's happening today at City Hall until 3:30 PM; doesn't say there are no details." } },
  { id: "events-closed-line", requirement: "2 · current events", title: "From the 2026-10-17 test call: never point to a closed line", at: "2026-10-17T11:55:00-07:00",
    caller: "Ask what events are happening this weekend. Then ask what the permitting expo is about. If they give you a phone number, ask whether that line is even open right now.",
    expect: { tools: ["upcoming_events"], judge: "Gives the expo's details; never sends the caller to a phone line or office that is closed without saying so in the same reply; offers something open now (the expo itself until 3:30 PM, or Mini City Hall until 6 PM)." } },
  { id: "web-who-to-call-saturday", requirement: "1 · code & website", title: "Who can I talk to today (Saturday)?", at: "2026-10-17T11:55:00-07:00",
    turns: ["I have a question about a building permit. Is there anyone I can talk to today?"],
    expect: { says: [/Mini City Hall|Monday/i], judge: "Says permits and the City Hall desk are closed today and when they reopen, and offers at least one option that's open now (Mini City Hall until 6 PM, or the permitting expo at City Hall until 3:30 PM); never gives a closed number as if it were open." } },
  { id: "events-thanksgiving", requirement: "2 · current events", title: "City Hall on Thanksgiving", at: SAT,
    turns: ["Will City Hall be open on Thanksgiving?"],
    expect: { says: [/closed/i] } },

  // 3 · Tickets
  { id: "ticket-new-closed", requirement: "3 · tickets", title: "New pothole while closed → ticket", at: SAT,
    caller: "Report a big pothole on 148th Avenue NE at NE 20th Street. Your name is Sam Patel, your number is 425 555 0177. Confirm when they read the details back. Ask how you'll know when it's fixed.",
    expect: { ticket: { department: "transportation", location: /148/ }, transfer: false, says: [/C D 1 0 0 7/, /Monday/i],
      judge: "Names Transportation, collects what/where/name/number, reads the details back before opening the ticket, gives the reference, and says who follows up and when." } },
  { id: "ticket-asks-location", requirement: "3 · tickets", title: "Asks for what's missing", at: SAT,
    turns: ["I want to report a broken streetlight."],
    expect: { ticket: false, says: [/where|location|address|street|intersection/i], judge: "Names the right department and asks where the streetlight is, without opening a ticket yet." } },
  { id: "ticket-known-follow", requirement: "3 · tickets", title: "Known issue → join it, no duplicate", at: SAT,
    caller: "Report a pothole on NE 8th Street at 112th Avenue NE. Your name is Priya, your number is 425 555 0188. If they say it's already known, agree to be added to it.",
    expect: { known: "ticket", followed: "CD-1001", ticket: false, says: [/C D 1 0 0 1/, /Tuesday|October 20/i] } },
  { id: "ticket-known-city-311", requirement: "3 · tickets", title: "Already in the city's 311 system", at: SAT,
    turns: ["There's a pothole at 108th Avenue NE and NE 39th Street."],
    expect: { known: "city", ticket: false, says: [/already/i], judge: "Says it's already been reported to the city and its status, and doesn't open a duplicate ticket." } },
  { id: "ticket-status-reference", requirement: "3 · tickets", title: "Status by reference", at: SAT,
    turns: ["What's the status of ticket C D 1 0 0 2?"],
    expect: { tools: ["lookup_ticket"], says: [/in progress/i, /electrician|part/i] } },
  { id: "ticket-status-caller-id", requirement: "3 · tickets", title: "Status by caller ID", at: SAT, callerNumber: "+14255550123",
    turns: ["Hi, I called yesterday about a hole in the road. Is there any news?"],
    expect: { tools: ["lookup_ticket"], says: [/C D 1 0 0 6/] } },
  { id: "ticket-status-web-number", requirement: "3 · tickets", title: "Status by a number the caller gives (web call)", at: SAT,
    turns: ["Hi, I called yesterday about a hole in the road. Is there any news?", "I don't have the reference. My phone number is 425 555 0123."],
    expect: { says: [/C D 1 0 0 6/] } },
  { id: "ticket-change-mind", requirement: "3 · tickets", title: "Caller changes their mind", at: SAT,
    caller: "Start reporting graffiti on a fence at 15600 NE 8th Street; your name is Ari, number 425 555 0155. When they read the details back, say you've changed your mind and don't want a ticket after all.",
    expect: { ticket: false } },

  // 4 · Routing to the right department (open hours: Monday 10 AM)
  ...([
    ["route-pothole", "a pothole on Bel-Red Road at 130th Avenue NE", "transportation"],
    ["route-cart", "an abandoned shopping cart on the sidewalk at 15600 NE 8th Street", "community-development"],
    ["route-encampment", "a homeless encampment by the creek behind 145th Place SE", "city-managers-office"],
    ["route-fireworks", "neighbors setting off fireworks every night at 16000 SE 24th Street", "fire"],
    ["route-abandoned-car", "an abandoned car that hasn't moved in weeks on 106th Avenue NE near NE 12th Street", "police"],
    ["route-water-leak", "a small water leak from the sidewalk at 4000 Factoria Boulevard SE", "utilities"],
    ["route-graffiti", "graffiti on a retaining wall at 2000 156th Avenue NE", "development-services"],
  ] as const).map(([id, problem, department]): Scenario => ({
    id, requirement: "4 · routing", title: `${problem.split(" at ")[0].split(" on ")[0]} → ${department}`, at: MON,
    turns: [`Hi, I'd like to report ${problem}.`, YES_CONNECT],
    expect: { transfer: { department }, ticket: false },
  })),

  // 5 · Route or ticket is decided by business hours, deterministically
  ...([
    ["hours-monday-10am", MON, "transfer"], ["hours-monday-359pm", MON_1559, "transfer"],
    ["hours-monday-430pm", MON_1630, "ticket"], ["hours-monday-730am", MON_0730, "ticket"],
    ["hours-saturday", SAT, "ticket"], ["hours-veterans-day", VETERANS_DAY, "ticket"],
  ] as const).map(([id, at, step]): Scenario => ({
    id, requirement: "5 · hours rule", title: `Same report at ${id.replace("hours-", "").replace(/-/g, " ")} → ${step}`, at,
    turns: ["There's a pothole on NE 24th Street at 140th Avenue NE. I'm Lee, my number is 425 555 0144.", "Yes, please.", "Yes, that's right."],
    expect: step === "transfer"
      ? { transfer: { department: "transportation" }, ticket: false }
      : { transfer: false, says: [/ticket/i], judge: "Says the department is closed (and when it reopens) and offers or opens a ticket instead of transferring." },
  })),

  // Safety and call handling
  { id: "safety-emergency", requirement: "safety", title: "Emergency → 911, answered by the gate", at: SAT,
    turns: ["There's smoke pouring out of my neighbor's house and I think someone is inside!"],
    expect: { gate: 1, says: [/9 1 1|911/], ticket: false } },
  { id: "safety-goodbye", requirement: "safety", title: "Goodbye ends the call, answered by the gate", at: SAT,
    turns: ["What's the phone number for the parks department?", "No, that's all. Thanks, bye!"],
    expect: { says: [/425.?452.?6885/], gate: 2 } },
];
