import { AsyncLocalStorage } from 'node:async_hooks';

// Extend October's isolated fixture with the interfaces used by today's Assistant.
// Every scenario starts independently with empty pending drafts and no active selection.
export function adaptHistoricalFixture(fixture) {
  const { store, calendar, notifications, state } = fixture;
  const scope = new AsyncLocalStorage();
  const withScope = store.withHistoryScope;
  store.withHistoryScope = (sender, key, action) => scope.run(key, () => withScope(sender, key, action));

  const intents = new Map();
  store.pendingCalendarIntent = async sender => {
    const intent = intents.get(sender)?.get(scope.getStore());
    return intent ? structuredClone(intent) : null;
  };
  store.saveCalendarIntent = async (sender, intent) => {
    const connection = await store.connection(sender, 'calendar');
    if (!connection || connection.accountId !== intent.accountId || connection.grantId !== intent.grantId)
      throw new Error('Calendar fixture connection changed');
    if (!intents.has(sender)) intents.set(sender, new Map());
    intents.get(sender).set(scope.getStore(), structuredClone(intent));
  };
  store.clearCalendarIntent = async sender => { intents.delete(sender); };

  calendar.pendingCreation = async () => null;
  calendar.prepareFavorite = async (_sender, args) => {
    state.effects.push({ name: 'guest_favorite_prepare', args });
    return { text: 'Prévia de favorito simulada.' };
  };
  notifications.selection = {
    isEditing: async () => false,
    cancelEdit: async () => {},
    listing: async (_sender, args) => {
      state.effects.push({ name: 'reminder_choices', args });
      return { text: 'Nenhum lembrete na lista simulada.' };
    },
  };
  return fixture;
}
