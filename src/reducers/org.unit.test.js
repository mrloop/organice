import { fromJS } from 'immutable';

import generateId from '../lib/id_generator';
import reducer from './org';
import rootReducer from './index';
import * as types from '../actions/org';
import { parseOrg } from '../lib/parse_org';
import { headerWithId } from '../lib/org_utils';
import { dateForTimestamp, timestampForDate } from '../lib/timestamps';
import { readInitialState } from '../util/settings_persister';

import { createStore, applyMiddleware } from 'redux';
import undoable, { ActionTypes } from 'redux-undo';
import thunk from 'redux-thunk';

import readFixture from '../../test_helpers/index';

describe('org reducer', () => {
  // Given a `header`, return its `title` and `nestingLevel`.
  function extractTitleAndNesting(header) {
    return [header.getIn(['titleLine', 'rawTitle']), header.get('nestingLevel')];
  }

  // Given some `headers`, return their `title`s and `nestingLevel`s.
  function extractTitlesAndNestings(headers) {
    return headers
      .map((header) => {
        return extractTitleAndNesting(header);
      })
      .toJS();
  }

  function check_is_undoable(state, action) {
    const store = createStore(undoable(reducer), state.org.present);

    // Perform an undoable action to warm up the redux-undo history.
    // Without this action, and without the
    // syncFilter: true flag in the undoable config,
    // the _lastUnfiltered field will be empty, and so will
    // be the 'past' after the INSERT_CAPTURE action.
    // The ADD_HEADER action is undoable so it gets saved
    // in _lastUnfiltered and then gets into the 'past' only to
    // be successfuly restored when we perform the UNDO.
    const firstHeader = state.org.present.get('headers').get(0).get('id');
    store.dispatch({ type: 'ADD_HEADER', headerId: firstHeader });

    const oldState = store.getState().present;
    store.dispatch(action);
    expect(store.getState().present).not.toEqual(oldState);
    store.dispatch({ type: ActionTypes.UNDO });
    expect(store.getState().present).toEqual(oldState);
  }

  function check_is_undoable_on_table(store, cellId, action) {
    const firstHeader = store.getState().present.get('headers').get(0).get('id');
    store.dispatch({ type: 'ADD_HEADER', headerId: firstHeader });

    store.dispatch({ type: 'SET_SELECTED_TABLE_CELL_ID', cellId });
    const oldState = store.getState().present;
    store.dispatch(action);
    expect(store.getState().present).not.toEqual(oldState);
    store.dispatch({ type: ActionTypes.UNDO });
    expect(store.getState().present).toEqual(oldState);
  }

  function check_kept_factory(oldState, newState) {
    return (query) => {
      expect(query(oldState)).toEqual(query(newState));
    };
  }

  describe('REFILE_SUBTREE', () => {
    let state;
    const testOrgFile = readFixture('main_test_file');
    let sourceHeaderId, targetHeaderId;

    beforeEach(() => {
      // The target is to refile "PROJECT Foo" into "A nested header".
      // They have both subheadlines, so it's not the trivial case.

      state = readInitialState();
      state.org.present = parseOrg(testOrgFile);

      // "PROJECT Foo" is the 10th item, "A nested header" the 2nd,
      // but we count from 0 not 1.
      sourceHeaderId = state.org.present.get('headers').get(9).get('id');
      targetHeaderId = state.org.present.get('headers').get(1).get('id');
    });

    it('should handle REFILE_SUBTREE', () => {
      // Mapping the headers to their nesting level. This is how the
      // initially parsed file should look like.
      expect(extractTitlesAndNestings(state.org.present.get('headers'))).toEqual([
        ['Top level header', 1],
        ['A nested header', 2],
        ['A todo item with schedule and deadline', 2],
        ['Another top level header', 1],
        ['A repeating todo', 2],
        ['A header with tags                                              ', 1],
        ['A header with [[https://organice.200ok.ch][a link]]', 1],
        ['A header with various links as content', 1],
        ['A header with a URL, mail address and phone number as content', 1],
        ['PROJECT Foo', 2],
        ["A headline that's done since a loong time", 3],
        ["A headline that's done a day earlier even", 3],
        ['A header with a custom todo sequence in DONE state', 1],
      ]);

      const action = types.refileSubtree(sourceHeaderId, targetHeaderId);
      const newState = reducer(state.org.present, action);

      // PROJECT Foo is now beneath "A nested header" and is
      // appropriately indented.
      expect(extractTitlesAndNestings(newState.get('headers'))).toEqual([
        ['Top level header', 1],
        ['A nested header', 2],
        ['PROJECT Foo', 3],
        ["A headline that's done since a loong time", 4],
        ["A headline that's done a day earlier even", 4],
        ['A todo item with schedule and deadline', 2],
        ['Another top level header', 1],
        ['A repeating todo', 2],
        ['A header with tags                                              ', 1],
        ['A header with [[https://organice.200ok.ch][a link]]', 1],
        ['A header with various links as content', 1],
        ['A header with a URL, mail address and phone number as content', 1],
        ['A header with a custom todo sequence in DONE state', 1],
      ]);
    });

    it('is undoable', () => {
      check_is_undoable(state, {
        type: 'REFILE_SUBTREE',
        sourceHeaderId,
        targetHeaderId,
        dirtying: true,
      });
    });
  });

  describe('INSERT_CAPTURE', () => {
    let store, template;
    let state;
    const testOrgFile = readFixture('nested_header');

    beforeEach(() => {
      template = {
        description: '',
        headerPaths: [],
        iconName: 'todo',
        id: generateId(),
        isAvailableInAllOrgFiles: false,
        letter: '',
        orgFilesWhereAvailable: [],
        shouldPrepend: false,
        template: '* TODO %?',
        isSample: true,
      };
      state = readInitialState();
      state.org.present = parseOrg(testOrgFile);
      state.capture = state.capture.update('captureTemplates', (templates) =>
        templates.push(fromJS(template))
      );

      // We have to create a full store rather than just the org bit,
      // because the insertCapture thunk needs to retrieve capture
      // templates from the capture part of the store.
      store = createStore(rootReducer, state, applyMiddleware(thunk));
    });

    const content = '* TODO My task\nSome description\n';

    function expectOrigFirstHeader(headers) {
      expect(extractTitleAndNesting(headers.first())).toEqual(['Top level header', 1]);
    }

    function expectOrigLastHeader(headers) {
      expect(extractTitleAndNesting(headers.last())).toEqual(['A deep nested header', 3]);
    }

    function insertCapture(shouldPrepend) {
      // Check initially parsed file looks as expected
      let headers = store.getState().org.present.get('headers');
      expect(headers.size).toEqual(3);
      expectOrigFirstHeader(headers);
      expectOrigLastHeader(headers);
      const action = types.insertCapture(template.id, content, shouldPrepend);
      store.dispatch(action);
      const newHeaders = store.getState().org.present.get('headers');
      expect(newHeaders.size).toEqual(4);
      return newHeaders;
    }

    it('should insert at top of file', () => {
      const newHeaders = insertCapture(true);
      expectOrigLastHeader(newHeaders);
      const first = newHeaders.first();
      expect(first.getIn(['titleLine', 'rawTitle'])).toEqual('My task');
      expect(first.getIn(['titleLine', 'todoKeyword'])).toEqual('TODO');
      expect(first.get('rawDescription')).toEqual('Some description\n');
    });

    it('should insert at bottom of file', () => {
      const newHeaders = insertCapture(false);
      expectOrigFirstHeader(newHeaders);
      const last = newHeaders.last();
      expect(last.getIn(['titleLine', 'rawTitle'])).toEqual('My task');
      expect(last.getIn(['titleLine', 'todoKeyword'])).toEqual('TODO');
      expect(last.get('rawDescription')).toEqual('Some description\n');
    });

    it('is undoable', () => {
      check_is_undoable(state, {
        type: 'INSERT_CAPTURE',
        template: fromJS(template),
        content,
        shouldPrepend: true,
        dirtying: true,
      });
    });
  });

  describe('MOVE_HEADER_LEFT', () => {
    let nestedHeaderId;
    let state;
    const testOrgFile = readFixture('nested_header');

    beforeEach(() => {
      state = readInitialState();
      state.org.present = parseOrg(testOrgFile);
      // The target is to move "A nested header" to the top level.

      // "A nested header" the 2nd item but we count from 0 not 1.
      nestedHeaderId = state.org.present.get('headers').get(1).get('id');
    });

    it('should handle MOVE_HEADER_LEFT', () => {
      // Mapping the headers to their nesting level. This is how the
      // initially parsed file should look like.
      expect(extractTitlesAndNestings(state.org.present.get('headers'))).toEqual([
        ['Top level header', 1],
        ['A nested header', 2],
        ['A deep nested header', 3],
      ]);

      const action = types.moveHeaderLeft(nestedHeaderId);
      const newState = reducer(state.org.present, action);

      // "A nested header" is not at the top level.
      expect(extractTitlesAndNestings(newState.get('headers'))).toEqual([
        ['Top level header', 1],
        ['A nested header', 1],
        ['A deep nested header', 3],
      ]);
    });

    it('is undoable', () => {
      check_is_undoable(state, types.moveHeaderLeft(nestedHeaderId));
    });
  });

  describe('MOVE_HEADER_RIGHT', () => {
    let nestedHeaderId;
    let state;
    const testOrgFile = readFixture('nested_header');

    beforeEach(() => {
      state = readInitialState();
      state.org.present = parseOrg(testOrgFile);
      // The target is to move "A nested header" to the next nesting level.

      // "A nested header" the 2nd item but we count from 0 not 1.
      nestedHeaderId = state.org.present.get('headers').get(1).get('id');
    });

    it('should handle MOVE_HEADER_RIGHT', () => {
      // Mapping the headers to their nesting level. This is how the
      // initially parsed file should look like.
      expect(extractTitlesAndNestings(state.org.present.get('headers'))).toEqual([
        ['Top level header', 1],
        ['A nested header', 2],
        ['A deep nested header', 3],
      ]);

      const action = types.moveHeaderRight(nestedHeaderId);
      const newState = reducer(state.org.present, action);

      // "A nested header" is not at the top level.
      expect(extractTitlesAndNestings(newState.get('headers'))).toEqual([
        ['Top level header', 1],
        ['A nested header', 3],
        ['A deep nested header', 3],
      ]);
    });

    it('is undoable', () => {
      check_is_undoable(state, types.moveHeaderRight(nestedHeaderId));
    });
  });

  describe('MOVE_SUBTREE_LEFT', () => {
    let nestedHeaderId;
    let state;
    const testOrgFile = readFixture('nested_header');

    beforeEach(() => {
      state = readInitialState();
      state.org.present = parseOrg(testOrgFile);
      // The target is to move "A nested header" to the top level.

      // "A nested header" the 2nd item but we count from 0 not 1.
      nestedHeaderId = state.org.present.get('headers').get(1).get('id');
    });

    it('should handle MOVE_SUBTREE_LEFT', () => {
      // Mapping the headers to their nesting level. This is how the
      // initially parsed file should look like.
      expect(extractTitlesAndNestings(state.org.present.get('headers'))).toEqual([
        ['Top level header', 1],
        ['A nested header', 2],
        ['A deep nested header', 3],
      ]);

      const action = types.moveSubtreeLeft(nestedHeaderId);
      const newState = reducer(state.org.present, action);

      // "A nested header" is not at the top level.
      expect(extractTitlesAndNestings(newState.get('headers'))).toEqual([
        ['Top level header', 1],
        ['A nested header', 1],
        ['A deep nested header', 2],
      ]);
    });

    it('is undoable', () => {
      check_is_undoable(state, types.moveSubtreeLeft(nestedHeaderId));
    });
  });

  describe('MOVE_SUBTREE_RIGHT', () => {
    let nestedHeaderId;
    let state;
    const testOrgFile = readFixture('nested_header');

    beforeEach(() => {
      state = readInitialState();
      state.org.present = parseOrg(testOrgFile);
      // The target is to move "A nested header" to the deeper nested level.

      // "A nested header" the 2nd item but we count from 0 not 1.
      nestedHeaderId = state.org.present.get('headers').get(1).get('id');
    });

    it('should handle MOVE_SUBTREE_RIGHT', () => {
      // Mapping the headers to their nesting level. This is how the
      // initially parsed file should look like.
      expect(extractTitlesAndNestings(state.org.present.get('headers'))).toEqual([
        ['Top level header', 1],
        ['A nested header', 2],
        ['A deep nested header', 3],
      ]);

      const action = types.moveSubtreeRight(nestedHeaderId);
      const newState = reducer(state.org.present, action);

      // "A nested header" is not at the top level.
      expect(extractTitlesAndNestings(newState.get('headers'))).toEqual([
        ['Top level header', 1],
        ['A nested header', 3],
        ['A deep nested header', 4],
      ]);
    });

    it('is undoable', () => {
      check_is_undoable(state, types.moveSubtreeRight(nestedHeaderId));
    });
  });

  describe('ADVANCE_TODO_STATE', () => {
    let regularHeaderId;
    let todoHeaderId;
    let doneHeaderId;
    let repeatingHeaderId;
    let state;
    const testOrgFile = readFixture('various_todos');

    beforeEach(() => {
      state = readInitialState();
      state.org.present = parseOrg(testOrgFile);
      // "This is done" is the 1st header,
      // "Header with repeater" is the 2nd,
      // "This is not a todo" is 3rd item, and
      // "Repeating task" is 4th item; we count from 1.
      doneHeaderId = state.org.present.get('headers').get(0).get('id');
      todoHeaderId = state.org.present.get('headers').get(1).get('id');
      regularHeaderId = state.org.present.get('headers').get(2).get('id');
      repeatingHeaderId = state.org.present.get('headers').get(3).get('id');
    });

    function check_todo_keyword_kept(oldHeaders, newHeaders, headerId) {
      expect(headerWithId(oldHeaders, headerId).getIn(['titleLine', 'todoKeyword'])).toEqual(
        headerWithId(newHeaders, headerId).getIn(['titleLine', 'todoKeyword'])
      );
    }
    function check_todo_keyword_changed(oldHeaders, newHeaders, headerId) {
      expect(headerWithId(oldHeaders, headerId).getIn(['titleLine', 'todoKeyword'])).not.toEqual(
        headerWithId(newHeaders, headerId).getIn(['titleLine', 'todoKeyword'])
      );
    }
    function check_header_kept(oldHeaders, newHeaders, headerId) {
      expect(headerWithId(oldHeaders, headerId)).toEqual(headerWithId(newHeaders, headerId));
    }

    it('should advance TODO state', () => {
      const oldHeaders = state.org.present.get('headers');
      const newHeaders = reducer(state.org.present, types.advanceTodoState(todoHeaderId)).get(
        'headers'
      );
      check_header_kept(oldHeaders, newHeaders, regularHeaderId);
      check_todo_keyword_changed(oldHeaders, newHeaders, todoHeaderId);
      check_header_kept(oldHeaders, newHeaders, doneHeaderId);

      // The nesting levels remain intact.
      expect(extractTitlesAndNestings(oldHeaders)).toEqual(extractTitlesAndNestings(newHeaders));
    });

    it('should advance DONE state', () => {
      const oldHeaders = state.org.present.get('headers');
      const newHeaders = reducer(state.org.present, types.advanceTodoState(doneHeaderId)).get(
        'headers'
      );
      check_header_kept(oldHeaders, newHeaders, regularHeaderId);
      check_header_kept(oldHeaders, newHeaders, todoHeaderId);
      check_todo_keyword_changed(oldHeaders, newHeaders, doneHeaderId);

      // The nesting levels remain intact.
      expect(extractTitlesAndNestings(oldHeaders)).toEqual(extractTitlesAndNestings(newHeaders));
    });

    it('should advance non-TODO state', () => {
      const oldHeaders = state.org.present.get('headers');
      const newHeaders = reducer(state.org.present, types.advanceTodoState(regularHeaderId)).get(
        'headers'
      );
      check_todo_keyword_changed(oldHeaders, newHeaders, regularHeaderId);
      check_header_kept(oldHeaders, newHeaders, todoHeaderId);
      check_header_kept(oldHeaders, newHeaders, doneHeaderId);

      // The nesting levels remain intact.
      expect(extractTitlesAndNestings(oldHeaders)).toEqual(extractTitlesAndNestings(newHeaders));
    });

    it('should advance repeating task', () => {
      const oldHeaders = state.org.present.get('headers');
      const newHeaders = reducer(state.org.present, types.advanceTodoState(repeatingHeaderId)).get(
        'headers'
      );
      check_todo_keyword_kept(oldHeaders, newHeaders, repeatingHeaderId);
      expect(headerWithId(newHeaders, repeatingHeaderId).get('description').size).toBeGreaterThan(
        headerWithId(oldHeaders, repeatingHeaderId).get('description').size
      );

      expect(headerWithId(newHeaders, repeatingHeaderId).get('planningItems')).not.toEqual(
        headerWithId(oldHeaders, repeatingHeaderId).get('planningItems')
      );

      // The nesting levels remain intact.
      expect(extractTitlesAndNestings(oldHeaders)).toEqual(extractTitlesAndNestings(newHeaders));
    });

    it('should advance repeating task again', () => {
      const intermState = reducer(state.org.present, types.advanceTodoState(repeatingHeaderId));
      const intermHeaders = intermState.get('headers');
      const newHeaders = reducer(intermState, types.advanceTodoState(repeatingHeaderId)).get(
        'headers'
      );
      check_todo_keyword_kept(intermHeaders, newHeaders, repeatingHeaderId);
      expect(headerWithId(newHeaders, repeatingHeaderId).get('description').size).toEqual(
        headerWithId(intermHeaders, repeatingHeaderId).get('description').size
      );

      expect(headerWithId(newHeaders, repeatingHeaderId).get('planningItems')).not.toEqual(
        headerWithId(intermHeaders, repeatingHeaderId).get('planningItems')
      );

      // The nesting levels remain intact.
      expect(extractTitlesAndNestings(intermHeaders)).toEqual(extractTitlesAndNestings(newHeaders));
    });

    it('is undoable', () => {
      check_is_undoable(state, types.advanceTodoState(todoHeaderId, true));
      check_is_undoable(state, types.advanceTodoState(doneHeaderId, false));
    });
  });

  describe('UPDATE_LOG_ENTRY_TIME', () => {
    let headerId;
    let irrelevantHeaderId;
    let state;
    const testOrgFile = readFixture('logbook');
    const date = new Date(98, 1);
    const ts = timestampForDate(date, { isActive: true, withStartTime: true });

    beforeEach(() => {
      state = readInitialState();
      state.org.present = parseOrg(testOrgFile);
      headerId = state.org.present.get('headers').get(0).get('id');
      irrelevantHeaderId = state.org.present.get('headers').get(1).get('id');
    });

    it('should handle UPDATE_LOG_ENTRY_TIME', () => {
      const newState = reducer(
        state.org.present,
        types.updateLogEntryTime(headerId, 0, 'start', ts)
      );
      expect(
        dateForTimestamp(
          headerWithId(newState.get('headers'), headerId).getIn(['logBookEntries', 0, 'start'])
        )
      ).toEqual(date);

      const check_kept = check_kept_factory(state.org.present, newState);
      check_kept((st) => st.get('headers').size);
      check_kept((st) => headerWithId(st.get('headers'), irrelevantHeaderId));
      check_kept((st) =>
        headerWithId(st.get('headers'), headerId).getIn(['titleLine', 'rawTitle'])
      );
      check_kept((st) => headerWithId(st.get('headers'), headerId).get('logBookEntries').size);
      check_kept((st) =>
        headerWithId(st.get('headers'), headerId).getIn(['logBookEntries', 1, 'start'])
      );
      check_kept((st) =>
        headerWithId(st.get('headers'), headerId).getIn(['logBookEntries', 1, 'end'])
      );
    });
  });

  describe('SET_ORG_FILE_ERROR_MESSAGE', () => {
    let state;
    const testOrgFile = readFixture('nested_header');
    const message = 'It’s Does Not Compute';

    beforeEach(() => {
      state = readInitialState();
      state.org.present = parseOrg(testOrgFile);
    });

    it('should handle SET_ORG_FILE_ERROR_MESSAGE', () => {
      const newState = reducer(state.org.present, types.setOrgFileErrorMessage(message));
      expect(newState.get('orgFileErrorMessage')).toEqual(message);
      expect(newState.get('headers')).toEqual(state.org.present.get('headers'));
    });
  });

  describe('UPDATE_PROPERTY_LIST_ITEMS', () => {
    let headerId;
    let irrelevantHeaderId;
    let state;
    const testOrgFile = readFixture('properties_extended');
    const properties = fromJS([
      { property: 'fst', value: 'car', id: generateId() },
      { property: 'snd', value: null, id: generateId() },
    ]);

    beforeEach(() => {
      state = readInitialState();
      state.org.present = parseOrg(testOrgFile);
      headerId = state.org.present.get('headers').get(1).get('id');
      irrelevantHeaderId = state.org.present.get('headers').get(0).get('id');
    });

    it('should handle UPDATE_PROPERTY_LIST_ITEMS', () => {
      const newState = reducer(
        state.org.present,
        types.updatePropertyListItems(headerId, properties)
      );

      expect(headerWithId(newState.get('headers'), headerId).get('propertyListItems')).toEqual(
        properties
      );

      const check_kept = check_kept_factory(state.org.present, newState);
      check_kept((st) => st.get('headers').size);
      check_kept((st) => headerWithId(st.get('headers'), irrelevantHeaderId));
      check_kept((st) =>
        headerWithId(st.get('headers'), headerId).getIn(['titleLine', 'rawTitle'])
      );
      check_kept((st) => headerWithId(st.get('headers'), headerId).get('logBookEntries'));
    });
  });

  describe('ADD_NEW_PLANNING_ITEM', () => {
    let headerId;
    let state;
    const testOrgFile = readFixture('schedule');

    beforeEach(() => {
      state = readInitialState();
      state.org.present = parseOrg(testOrgFile);
      headerId = state.org.present.get('headers').get(0).get('id');
    });

    it('should handle ADD_NEW_PLANNING_ITEM', () => {
      const newState = reducer(state.org.present, types.addNewPlanningItem(headerId, 'DEADLINE'));
      expect(headerWithId(newState.get('headers'), headerId).get('planningItems').size).toEqual(2);
      expect(
        headerWithId(newState.get('headers'), headerId).get('planningItems').get(0).get('type')
      ).toEqual('SCHEDULED');
      expect(
        headerWithId(newState.get('headers'), headerId).get('planningItems').get(1).get('type')
      ).toEqual('DEADLINE');

      const check_kept = check_kept_factory(state.org.present, newState);
      check_kept((st) => st.get('headers').size);
      check_kept((st) =>
        headerWithId(st.get('headers'), headerId).getIn(['titleLine', 'rawTitle'])
      );
      check_kept((st) =>
        headerWithId(st.get('headers'), headerId).getIn(['titleLine', 'todoKeyword'])
      );
      check_kept((st) => headerWithId(st.get('headers'), headerId).get('logBookEntries'));
    });
  });

  describe('UPDATE_PLANING_ITEM_TIMESTAMP', () => {
    let headerId;
    let state;
    const testOrgFile = readFixture('schedule');
    const date = new Date(98, 1);
    const ts = timestampForDate(date, { isActive: true, withStartTime: true });

    beforeEach(() => {
      state = readInitialState();
      state.org.present = parseOrg(testOrgFile);
      headerId = state.org.present.get('headers').get(0).get('id');
    });

    it('should handle UPDATE_PLANING_ITEM_TIMESTAMP', () => {
      const newState = reducer(
        state.org.present,
        types.updatePlanningItemTimestamp(headerId, 0, ts)
      );
      expect(
        headerWithId(newState.get('headers'), headerId).get('planningItems').get(0).get('type')
      ).toEqual('SCHEDULED');

      expect(
        headerWithId(newState.get('headers'), headerId).get('planningItems').get(0).get('timestamp')
      ).toEqual(ts);

      const check_kept = check_kept_factory(state.org.present, newState);
      check_kept((st) => st.get('headers').size);
      check_kept((st) => headerWithId(st.get('headers'), headerId).get('planningItems').size);
      check_kept((st) =>
        headerWithId(st.get('headers'), headerId).getIn(['titleLine', 'rawTitle'])
      );
      check_kept((st) =>
        headerWithId(st.get('headers'), headerId).getIn(['titleLine', 'todoKeyword'])
      );
      check_kept((st) => headerWithId(st.get('headers'), headerId).get('logBookEntries'));
    });
  });

  describe('UPDATE_TIMESTAMP_WITH_ID', () => {
    let state;
    let headerId;
    const testOrgFile = readFixture('schedule_and_timestamps');
    const date = new Date(98, 1);
    const ts = timestampForDate(date, { isActive: true, withStartTime: true });
    let headerTsId;
    let bodyTsId;

    beforeEach(() => {
      state = readInitialState();
      state.org.present = parseOrg(testOrgFile);
      headerId = state.org.present.get('headers').get(0).get('id');
      headerTsId = state.org.present.getIn(['headers', 0, 'titleLine', 'title', 0, 'id']);
      bodyTsId = state.org.present.getIn(['headers', 0, 'description', 2, 'id']);
    });

    it('should update timestamp in a header', () => {
      const oldState = state.org.present;
      const newState = reducer(
        oldState,
        types.updateTimestampWithId(
          headerTsId,
          fromJS({ id: headerTsId, type: 'timestamp', firstTimestamp: ts, secondTimestamp: null })
        )
      );
      expect(
        headerWithId(newState.get('headers'), headerId)
          .getIn(['titleLine', 'title', 0, 'firstTimestamp'])
          .toJS()
      ).toEqual(ts);

      const check_kept = check_kept_factory(oldState, newState);
      check_kept((st) => st.get('headers').size);
      check_kept((st) => headerWithId(st.get('headers'), headerId).get('description'));
      check_kept((st) => headerWithId(st.get('headers'), headerId).get('rawDescription'));
    });

    it('should update timestamp in a description', () => {
      const oldState = state.org.present;
      const newState = reducer(
        oldState,
        types.updateTimestampWithId(
          bodyTsId,
          fromJS({ id: bodyTsId, type: 'timestamp', firstTimestamp: ts, secondTimestamp: null })
        )
      );
      expect(
        headerWithId(newState.get('headers'), headerId)
          .getIn(['description', 2, 'firstTimestamp'])
          .toJS()
      ).toEqual(ts);
      const check_kept = check_kept_factory(oldState, newState);
      check_kept((st) => st.get('headers').size);
      check_kept((st) => headerWithId(st.get('headers'), headerId).get('titleLine'));
    });
  });

  describe('REORDER_PROPERTY_LIST', () => {
    let headerId;
    let irrelevantHeaderId;
    let state;
    const testOrgFile = readFixture('properties_extended');
    const fromIndex = 1;
    const toIndex = 3;

    beforeEach(() => {
      state = readInitialState();
      state.org.present = parseOrg(testOrgFile);
      headerId = state.org.present.get('headers').get(0).get('id');
      irrelevantHeaderId = state.org.present.get('headers').get(1).get('id');
    });

    it('should handle REORDER_PROPERTY_LIST', () => {
      const newState = reducer(state.org.present, {
        type: 'REORDER_PROPERTY_LIST',
        fromIndex,
        toIndex,
        headerId,
        dirtying: true,
      });

      expect(
        headerWithId(newState.get('headers'), headerId)
          .get('propertyListItems')
          .toJS()
          .map((x) => x.property)
      ).toEqual(['foo', 'baz', 'bay', 'bar']);

      const check_kept = check_kept_factory(state.org.present, newState);
      check_kept((st) => st.get('headers').size);
      check_kept((st) => headerWithId(st.get('headers'), irrelevantHeaderId));
      check_kept((st) =>
        headerWithId(st.get('headers'), headerId).getIn(['titleLine', 'rawTitle'])
      );
      check_kept((st) => headerWithId(st.get('headers'), headerId).get('logBookEntries'));
    });
  });

  describe('REORDER_TAGS', () => {
    let headerId;
    let state;
    const testOrgFile = readFixture('more_tags');
    const fromIndex = 0;
    const toIndex = 2;

    beforeEach(() => {
      state = readInitialState();
      state.org.present = parseOrg(testOrgFile);
      headerId = state.org.present.get('headers').get(0).get('id');
    });

    it('should handle REORDER_TAGS', () => {
      const stateSelected = reducer(state.org.present, { type: 'SELECT_HEADER', headerId });
      const newState = reducer(stateSelected, types.reorderTags(fromIndex, toIndex));

      expect(stateSelected.get('selectedHeaderId')).toEqual(headerId);
      expect(newState.get('selectedHeaderId')).toEqual(headerId);
      expect(
        headerWithId(newState.get('headers'), headerId).getIn(['titleLine', 'tags']).toJS()
      ).toEqual(['t2', 't3', 't1', 'spec_tag']);

      const check_kept = check_kept_factory(state.org.present, newState);
      check_kept((st) => st.get('headers').size);
      check_kept((st) => headerWithId(st.get('headers'), headerId).getIn(['titleLine', 'title']));
      check_kept((st) =>
        headerWithId(st.get('headers'), headerId).getIn(['titleLine', 'rawTitle'])
      );
      check_kept((st) => headerWithId(st.get('headers'), headerId).get('description'));
    });
  });

  describe('SET_HEADER_TAGS', () => {
    let irrelevantHeaderId;
    let state;
    const testOrgFile = readFixture('more_tags');
    const tags = fromJS(['ta', 't1', 'spec_tag']);

    beforeEach(() => {
      state = readInitialState();
      state.org.present = parseOrg(testOrgFile);
      irrelevantHeaderId = state.org.present.get('headers').get(0).get('id');
    });

    it('should handle SET_HEADER_TAGS', () => {
      const stateInserted = reducer(state.org.present, types.addHeader(0));
      const headerId = stateInserted.get('headers').get(0).get('id');
      const newState = reducer(stateInserted, types.setHeaderTags(headerId, tags));

      expect(headerWithId(newState.get('headers'), headerId).getIn(['titleLine', 'tags'])).toEqual(
        tags
      );

      const check_kept = check_kept_factory(state.org.present, newState);
      check_kept((st) => headerWithId(st.get('headers'), irrelevantHeaderId));
    });
  });

  describe('ADVANCE_CHECKBOX_STATE', () => {
    let headerId;
    let checkedBoxId;
    let uncheckedBoxId;
    let irrelevantHeaderId;
    let state;
    const testOrgFile = readFixture('checkboxes');

    beforeEach(() => {
      state = readInitialState();
      state.org.present = parseOrg(testOrgFile);
      let headers = state.org.present.get('headers');
      headerId = headers.get(0).get('id');
      irrelevantHeaderId = headers.get(1).get('id');
      checkedBoxId = headerWithId(headers, headerId).getIn(['description', 0, 'items', 2, 'id']);
      uncheckedBoxId = headerWithId(headers, headerId).getIn(['description', 0, 'items', 1, 'id']);
    });

    it('should check the box', () => {
      const oldState = state.org.present;
      const newState = reducer(oldState, types.advanceCheckboxState(uncheckedBoxId));

      expect(
        headerWithId(newState.get('headers'), headerId)
          .getIn(['description', 0, 'items'])
          .toJS()
          .map((x) => x.checkboxState)
      ).toEqual(['unchecked', 'checked', 'checked']);

      const check_kept = check_kept_factory(oldState, newState);
      check_kept((st) =>
        headerWithId(st.get('headers'), headerId).getIn(['description', 0, 'items', 0])
      );
      check_kept((st) => headerWithId(st.get('headers'), irrelevantHeaderId));
    });

    it('should uncheck the box', () => {
      const oldState = state.org.present;
      const newState = reducer(oldState, types.advanceCheckboxState(checkedBoxId));

      expect(
        headerWithId(newState.get('headers'), headerId)
          .getIn(['description', 0, 'items'])
          .toJS()
          .map((x) => x.checkboxState)
      ).toEqual(['unchecked', 'unchecked', 'unchecked']);

      const check_kept = check_kept_factory(oldState, newState);
      check_kept((st) =>
        headerWithId(st.get('headers'), headerId).getIn(['description', 0, 'items', 0])
      );
      check_kept((st) => headerWithId(st.get('headers'), irrelevantHeaderId));
    });
  });

  describe('CLEAR_PENDING_CAPTURE', () => {
    let state;

    beforeEach(() => {
      state = readInitialState();
    });

    it('should handle CLEAR_PENDING_CAPTURE', () => {
      const newState = reducer(state.org.present, types.clearPendingCapture());
      expect(newState.get('pendingCapture')).toBeNull();
    });
  });

  function firstTable(state) {
    let hdrContents = state.getIn(['headers', 0, 'description']);
    return hdrContents.find((item) => item.get('type') === 'table');
  }

  describe('UPDATE_TABLE_CELL_VALUE', () => {
    let state;
    let cellId;
    const newValue = 'Murakami';
    const testOrgFile = readFixture('table');

    beforeEach(() => {
      state = readInitialState();
      state.org.present = parseOrg(testOrgFile);
      cellId = firstTable(state.org.present).getIn(['contents', 1, 'contents', 1, 'id']);
    });

    it('should handle UPDATE_TABLE_CELL_VALUE', () => {
      const newState = reducer(state.org.present, types.updateTableCellValue(cellId, newValue));
      expect(
        firstTable(newState).getIn(['contents', 1, 'contents', 1, 'contents', 0, 'contents'])
      ).toEqual(newValue);
      expect(firstTable(newState).getIn(['contents', 1, 'contents', 1, 'rawContents'])).toEqual(
        newValue
      );
      const check_kept = check_kept_factory(state.org.present, newState);
      check_kept((st) => st.getIn('headers', 0, 'titleLine'));
      check_kept((st) => firstTable(st).getIn(['contents', 0, 'contents']));
      check_kept((st) => firstTable(st).getIn(['contents', 2, 'contents']));
      check_kept((st) => firstTable(st).getIn(['contents', 1, 'contents', 0]));
      check_kept((st) => firstTable(st).getIn(['contents', 1, 'contents', 2]));
    });
  });

  describe('MOVE_TABLE_COLUMN_RIGHT', () => {
    let state;
    let store;
    let cellId;
    const testOrgFile = readFixture('table');

    beforeEach(() => {
      state = readInitialState();
      state.org.present = parseOrg(testOrgFile);
      cellId = firstTable(state.org.present).getIn(['contents', 1, 'contents', 1, 'id']);
      store = createStore(undoable(reducer), state.org.present);
    });

    it('should handle MOVE_TABLE_COLUMN_RIGHT', () => {
      const oldState = store.getState().present;
      store.dispatch({ type: 'SET_SELECTED_TABLE_CELL_ID', cellId });
      const stateCellSelected = store.getState().present;
      const newState = reducer(stateCellSelected, types.moveTableColumnRight());
      const check_kept = check_kept_factory(state.org.present, newState);

      [0, 1, 2].forEach((i) => {
        expect(firstTable(newState).getIn(['contents', i, 'contents', 1])).toEqual(
          firstTable(oldState).getIn(['contents', i, 'contents', 2])
        );
        expect(firstTable(newState).getIn(['contents', i, 'contents', 2])).toEqual(
          firstTable(oldState).getIn(['contents', i, 'contents', 1])
        );
        check_kept((st) => firstTable(st).getIn(['contents', i, 'contents', 0]));
        check_kept((st) => firstTable(st).getIn(['contents', i, 'contents']).size);
      });
      check_kept((st) => firstTable(st).get('contents').size);
    });

    it('is undoable', () => {
      check_is_undoable_on_table(store, cellId, types.moveTableColumnRight());
    });
  });

  describe('MOVE_TABLE_COLUMN_LEFT', () => {
    let state;
    let store;
    let cellId;
    const testOrgFile = readFixture('table');

    beforeEach(() => {
      state = readInitialState();
      state.org.present = parseOrg(testOrgFile);
      cellId = firstTable(state.org.present).getIn(['contents', 1, 'contents', 1, 'id']);
      store = createStore(undoable(reducer), state.org.present);
    });

    it('should handle MOVE_TABLE_COLUMN_LEFT', () => {
      const oldState = store.getState().present;
      store.dispatch({ type: 'SET_SELECTED_TABLE_CELL_ID', cellId });
      const stateCellSelected = store.getState().present;
      const newState = reducer(stateCellSelected, types.moveTableColumnLeft());
      const check_kept = check_kept_factory(state.org.present, newState);

      [0, 1, 2].forEach((i) => {
        expect(firstTable(newState).getIn(['contents', i, 'contents', 1])).toEqual(
          firstTable(oldState).getIn(['contents', i, 'contents', 0])
        );
        expect(firstTable(newState).getIn(['contents', i, 'contents', 0])).toEqual(
          firstTable(oldState).getIn(['contents', i, 'contents', 1])
        );
        check_kept((st) => firstTable(st).getIn(['contents', i, 'contents', 2]));
        check_kept((st) => firstTable(st).getIn(['contents', i, 'contents']).size);
      });
      check_kept((st) => firstTable(st).get('contents').size);
    });

    it('is undoable', () => {
      check_is_undoable_on_table(store, cellId, types.moveTableColumnLeft());
    });
  });

  describe('MOVE_TABLE_ROW_UP', () => {
    let state;
    let store;
    let cellId;
    const testOrgFile = readFixture('table');

    beforeEach(() => {
      state = readInitialState();
      state.org.present = parseOrg(testOrgFile);
      cellId = firstTable(state.org.present).getIn(['contents', 1, 'contents', 1, 'id']);
      store = createStore(undoable(reducer), state.org.present);
    });

    it('should handle MOVE_TABLE_ROW_UP', () => {
      const oldState = store.getState().present;
      store.dispatch({ type: 'SET_SELECTED_TABLE_CELL_ID', cellId });
      const stateCellSelected = store.getState().present;
      const newState = reducer(stateCellSelected, types.moveTableRowUp());
      const check_kept = check_kept_factory(state.org.present, newState);

      expect(firstTable(newState).getIn(['contents', 0])).toEqual(
        firstTable(oldState).getIn(['contents', 1])
      );
      expect(firstTable(newState).getIn(['contents', 1])).toEqual(
        firstTable(oldState).getIn(['contents', 0])
      );
      check_kept((st) => firstTable(st).getIn(['contents', 2]));
      check_kept((st) => firstTable(st).get('contents').size);
    });

    it('is undoable', () => {
      check_is_undoable_on_table(store, cellId, types.moveTableRowUp());
    });
  });

  describe('MOVE_TABLE_ROW_DOWN', () => {
    let state;
    let store;
    let cellId;
    const testOrgFile = readFixture('table');

    beforeEach(() => {
      state = readInitialState();
      state.org.present = parseOrg(testOrgFile);
      cellId = firstTable(state.org.present).getIn(['contents', 1, 'contents', 1, 'id']);
      store = createStore(undoable(reducer), state.org.present);
    });

    it('should handle MOVE_TABLE_ROW_DOWN', () => {
      const oldState = store.getState().present;
      store.dispatch({ type: 'SET_SELECTED_TABLE_CELL_ID', cellId });
      const stateCellSelected = store.getState().present;
      const newState = reducer(stateCellSelected, types.moveTableRowDown());
      const check_kept = check_kept_factory(state.org.present, newState);

      expect(firstTable(newState).getIn(['contents', 2])).toEqual(
        firstTable(oldState).getIn(['contents', 1])
      );
      expect(firstTable(newState).getIn(['contents', 1])).toEqual(
        firstTable(oldState).getIn(['contents', 2])
      );
      check_kept((st) => firstTable(st).getIn(['contents', 0]));
      check_kept((st) => firstTable(st).get('contents').size);
    });

    it('is undoable', () => {
      check_is_undoable_on_table(store, cellId, types.moveTableRowDown());
    });
  });

  describe('REMOVE_TABLE_COLUMN', () => {
    let state;
    let store;
    let cellId;
    const testOrgFile = readFixture('table');

    beforeEach(() => {
      state = readInitialState();
      state.org.present = parseOrg(testOrgFile);
      cellId = firstTable(state.org.present).getIn(['contents', 1, 'contents', 1, 'id']);
      store = createStore(undoable(reducer), state.org.present);
    });

    it('should handle REMOVE_TABLE_COLUMN', () => {
      const oldState = store.getState().present;
      store.dispatch({ type: 'SET_SELECTED_TABLE_CELL_ID', cellId });
      const stateCellSelected = store.getState().present;
      const newState = reducer(stateCellSelected, types.removeTableColumn());
      const check_kept = check_kept_factory(state.org.present, newState);

      [0, 1, 2].forEach((i) => {
        expect(firstTable(newState).getIn(['contents', i, 'contents']).size).toEqual(
          firstTable(oldState).getIn(['contents', i, 'contents']).size - 1
        );
        expect(firstTable(newState).getIn(['contents', i, 'contents', 1])).toEqual(
          firstTable(oldState).getIn(['contents', i, 'contents', 2])
        );
        check_kept((st) => firstTable(st).getIn(['contents', i, 'contents', 0]));
      });
      check_kept((st) => firstTable(st).get('contents').size);
    });
    it('is undoable', () => {
      check_is_undoable_on_table(store, cellId, types.removeTableColumn());
    });
  });

  describe('REMOVE_TABLE_ROW', () => {
    let state;
    let store;
    let cellId;
    const testOrgFile = readFixture('table');

    beforeEach(() => {
      state = readInitialState();
      state.org.present = parseOrg(testOrgFile);
      cellId = firstTable(state.org.present).getIn(['contents', 1, 'contents', 1, 'id']);
      store = createStore(undoable(reducer), state.org.present);
    });

    it('should handle REMOVE_TABLE_ROW', () => {
      const oldState = store.getState().present;
      store.dispatch({ type: 'SET_SELECTED_TABLE_CELL_ID', cellId });
      const stateCellSelected = store.getState().present;
      const newState = reducer(stateCellSelected, types.removeTableRow());
      const check_kept = check_kept_factory(state.org.present, newState);

      expect(firstTable(newState).getIn(['contents']).size).toEqual(
        firstTable(oldState).getIn(['contents']).size - 1
      );

      expect(firstTable(newState).getIn(['contents', 1])).toEqual(
        firstTable(oldState).getIn(['contents', 2])
      );

      check_kept((st) => firstTable(st).getIn(['contents', 0]));
    });

    it('is undoable', () => {
      check_is_undoable_on_table(store, cellId, types.removeTableRow());
    });
  });

  describe('ADD_NEW_TABLE_COLUMN', () => {
    let state;
    let store;
    let cellId;
    const testOrgFile = readFixture('table');

    beforeEach(() => {
      state = readInitialState();
      state.org.present = parseOrg(testOrgFile);
      cellId = firstTable(state.org.present).getIn(['contents', 1, 'contents', 1, 'id']);
      store = createStore(undoable(reducer), state.org.present);
    });

    it('should handle ADD_NEW_TABLE_COLUMN', () => {
      const oldState = store.getState().present;
      store.dispatch({ type: 'SET_SELECTED_TABLE_CELL_ID', cellId });
      const stateCellSelected = store.getState().present;
      const newState = reducer(stateCellSelected, types.addNewTableColumn());
      const check_kept = check_kept_factory(state.org.present, newState);

      [0, 1, 2].forEach((i) => {
        expect(firstTable(newState).getIn(['contents', i, 'contents']).size).toEqual(
          firstTable(oldState).getIn(['contents', i, 'contents']).size + 1
        );
        expect(firstTable(newState).getIn(['contents', i, 'contents', 3])).toEqual(
          firstTable(oldState).getIn(['contents', i, 'contents', 2])
        );
        check_kept((st) => firstTable(st).getIn(['contents', i, 'contents', 0]));
        check_kept((st) => firstTable(st).getIn(['contents', i, 'contents', 1]));
      });
      check_kept((st) => firstTable(st).get('contents').size);
    });

    it('is undoable', () => {
      check_is_undoable_on_table(store, cellId, types.addNewTableColumn());
    });
  });

  describe('ADD_NEW_TABLE_ROW', () => {
    let state;
    let store;
    let cellId;
    const testOrgFile = readFixture('table');

    beforeEach(() => {
      state = readInitialState();
      state.org.present = parseOrg(testOrgFile);
      cellId = firstTable(state.org.present).getIn(['contents', 1, 'contents', 1, 'id']);
      store = createStore(undoable(reducer), state.org.present);
    });

    it('should handle ADD_NEW_TABLE_ROW', () => {
      const oldState = store.getState().present;
      store.dispatch({ type: 'SET_SELECTED_TABLE_CELL_ID', cellId });
      const stateCellSelected = store.getState().present;
      const newState = reducer(stateCellSelected, types.addNewTableRow());
      const check_kept = check_kept_factory(state.org.present, newState);

      [0, 1].forEach((i) => {});
      check_kept((st) => firstTable(st).getIn(['contents', 0]));
      check_kept((st) => firstTable(st).getIn(['contents', 1]));
      expect(firstTable(newState).getIn(['contents', 3])).toEqual(
        firstTable(oldState).getIn(['contents', 2])
      );
      expect(firstTable(newState).getIn(['contents']).size).toEqual(
        firstTable(oldState).getIn(['contents']).size + 1
      );
    });

    it('is undoable', () => {
      check_is_undoable_on_table(store, cellId, types.addNewTableRow());
    });
  });

  describe('FOCUS_HEADER', () => {
    let state;
    const headerId = generateId();

    beforeEach(() => {
      state = readInitialState();
    });

    it('should handle FOCUS_HEADER', () => {
      const newState = reducer(state.org.present, types.focusHeader(headerId));
      expect(newState.get('focusedHeaderId')).toEqual(headerId);
    });
  });
});
