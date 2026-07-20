// Sample data for trying the app out. First names only, on purpose —
// the planner is meant to hold minimized data even when it's fake.

import { uid } from './store.js';
import { newClient, newSessionType } from '../actions.js';

export function sampleData() {
  const sess = (label, location, modality, duration = 60) => ({
    ...newSessionType(label), location, modality, duration,
  });

  // Full names live on the Jane side; normalizeData turns them into
  // JNe-style display codes (autoName).
  const c = (fullName, type, sessions, extra = {}) => newClient({
    name: fullName,
    type,               // 'weekly' | 'biweekly' | 'monthly' | 'self'
    sessions,
    jane: { id: null, name: fullName },
    ...extra,
  });

  const ana = c('Ana Alvarez', 'weekly', [
    sess('Individual', 'in-person', 'CBT'),
    sess('Parent session', 'virtual', '', 30),
  ], {
    schedulingNotes: 'Prefers mornings. Can’t do Fridays.',
    casePlan: {
      workingOn: 'Boundary-setting at work; noticing early anger cues.',
      nextSession: 'Review the conversation with her manager.',
      longTermGoals: 'Steadier sense of self outside of achievement.',
      log: [
        { date: '2026-07-14', text: 'Big step: said no to weekend overtime.' },
        { date: '2026-07-07', text: 'Introduced the two-chair exercise.' },
      ],
    },
  });
  const maya = c('Maya Osei', 'weekly', [sess('Individual', 'virtual', 'ACT')]);
  const priya = c('Priya Sharma', 'weekly', [sess('Individual', 'in-person', 'EMDR')],
    { schedulingNotes: 'Saturdays only.' });

  const ben = c('Ben Carter', 'biweekly', [sess('Individual', 'virtual', 'DBT')]);
  const chloe = c('Chloe Nguyen', 'biweekly', [sess('Individual', 'in-person', 'Grief work')], {
    casePlan: { workingOn: 'Grief work — first year.', nextSession: '', longTermGoals: '', log: [] },
  });
  const sam = c('Sam Piper', 'biweekly', [sess('Individual', 'mixed', 'CBT')]);
  const dana = c('Dana Wolfe', 'biweekly', [sess('Individual', 'virtual', 'CBT')],
    { schedulingNotes: 'Shares the Tue 9 slot with BCa, alternate weeks.' });
  const omar = c('Omar Haddad', 'biweekly', [sess('Trauma work', 'in-person', 'DBT-PE', 90)]);
  const lena = c('Lena Brooks', 'biweekly', [sess('Couples', 'virtual', 'Couples')]);
  const farah = c('Farah Aziz', 'biweekly', [sess('Check-in', 'virtual', 'DBT', 30)],
    { schedulingNotes: '30-minute check-ins for now.' });

  const grace = c('Grace Lam', 'monthly', [sess('Family', 'in-person', 'Family')],
    { schedulingNotes: 'Usually first week of the month, afternoons.' });
  const noor = c('Noor Malik', 'self', [sess('Individual', 'virtual', 'ACT')],
    { schedulingNotes: 'Self-booking through Jane, evenings mostly.' });

  const iris = c('Iris Fontaine', 'biweekly', [sess('Individual', 'in-person', 'CBT')], {
    status: 'paused',
    paused: { since: '2026-06-02', expectedReturn: 'September', note: 'Away for the summer; keep her Thursday in mind.' },
  });

  const clients = [ana, maya, priya, ben, chloe, sam, dana, omar, lena, farah, grace, noor, iris];

  const a = (client, day, start, parity, duration = 60, sessionIdx = 0) => ({
    id: uid(),
    clientId: client.id,
    day,
    start,
    duration,
    parity,
    sessionId: client.sessions[sessionIdx].id,
  });

  const assignments = [
    a(ana, 2, 10 * 60, 'both'),
    a(maya, 4, 13 * 60, 'both'),
    a(priya, 6, 9 * 60, 'both'),
    a(ben, 2, 9 * 60, 0),
    a(dana, 2, 9 * 60, 1),
    a(chloe, 3, 11 * 60, 0),
    a(omar, 3, 14 * 60, 1, 90),
    a(sam, 5, 15 * 60, 0),
    a(lena, 6, 12 * 60, 1),
    a(farah, 4, 16 * 60, 1, 30),
    a(iris, 4, 10 * 60, 0),
  ];

  return { clients, assignments };
}
