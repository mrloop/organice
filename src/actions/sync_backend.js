/* global gapi */
import { ActionCreators } from 'redux-undo';

import { setLoadingMessage, hideLoadingMessage, clearModalStack, setIsLoading } from './base';
import { parseFile, setDirty, setLastSyncAt, setOrgFileErrorMessage } from './org';
import { localStorageAvailable, persistField } from '../util/settings_persister';
import { createGitlabOAuth } from '../sync_backend_clients/gitlab_sync_backend_client';

import { addSeconds } from 'date-fns';

export const signOut = () => (dispatch, getState) => {
  switch (getState().syncBackend.get('client', {}).type) {
    case 'WebDAV':
      ['Endpoint', 'Username', 'Password'].forEach((e) => {
        persistField('webdav' + e, null);
      });
      break;
    case 'Dropbox':
      persistField('dropboxAccessToken', null);
      break;
    case 'Google Drive':
      gapi.auth2.getAuthInstance().signOut();
      break;
    case 'GitLab':
      persistField('gitLabProject', null);
      createGitlabOAuth().reset();
      break;
    default:
  }

  persistField('authenticatedSyncService', null);

  dispatch({ type: 'SIGN_OUT' });
  dispatch(clearModalStack());
  dispatch(hideLoadingMessage());

  if (localStorageAvailable) {
    localStorage.clear();
  }
};

export const setCurrentFileBrowserDirectoryListing = (
  directoryListing,
  hasMore,
  additionalSyncBackendState
) => ({
  type: 'SET_CURRENT_FILE_BROWSER_DIRECTORY_LISTING',
  directoryListing,
  hasMore,
  additionalSyncBackendState,
});

export const setIsLoadingMoreDirectoryListing = (isLoadingMore) => ({
  type: 'SET_IS_LOADING_MORE_DIRECTORY_LISTING',
  isLoadingMore,
});

export const getDirectoryListing = (path) => (dispatch, getState) => {
  dispatch(setLoadingMessage('Getting listing...'));

  const client = getState().syncBackend.get('client');
  client
    .getDirectoryListing(path)
    .then(({ listing, hasMore, additionalSyncBackendState }) => {
      dispatch(setCurrentFileBrowserDirectoryListing(listing, hasMore, additionalSyncBackendState));
      dispatch(hideLoadingMessage());
    })
    .catch((error) => {
      alert('There was an error retrieving files!');
      console.error(error);
      dispatch(hideLoadingMessage());
    });
};

export const loadMoreDirectoryListing = () => (dispatch, getState) => {
  dispatch(setIsLoadingMoreDirectoryListing(true));

  const client = getState().syncBackend.get('client');
  const currentFileBrowserDirectoryListing = getState().syncBackend.get(
    'currentFileBrowserDirectoryListing'
  );
  client
    .getMoreDirectoryListing(currentFileBrowserDirectoryListing.get('additionalSyncBackendState'))
    .then(({ listing, hasMore, additionalSyncBackendState }) => {
      const extendedListing = currentFileBrowserDirectoryListing.get('listing').concat(listing);
      dispatch(
        setCurrentFileBrowserDirectoryListing(extendedListing, hasMore, additionalSyncBackendState)
      );
      dispatch(setIsLoadingMoreDirectoryListing(false));
    });
};

export const pushBackup = (pathOrFileId, contents) => {
  return (dispatch, getState) => {
    const client = getState().syncBackend.get('client');
    switch (client.type) {
      case 'Dropbox':
      case 'WebDAV':
        client.createFile(`${pathOrFileId}.organice-bak`, contents);
        break;
      case 'Google Drive':
        pathOrFileId = pathOrFileId.startsWith('/') ? pathOrFileId.substr(1) : pathOrFileId;
        client.duplicateFile(pathOrFileId, (fileName) => `${fileName}.organice-bak`);
        break;
      case 'GitLab':
        // No-op for GitLab, because the beauty of version control makes backup files redundant.
        break;
      case 'File System':
        client.createFile(`${pathOrFileId}.organice-bak`, contents);
        break;
      default:
    }
  };
};

export const downloadFile = (path) => {
  return (dispatch, getState) => {
    dispatch(setLoadingMessage(`Downloading file ...`));
    getState()
      .syncBackend.get('client')
      .getFileContents(path)
      .then((fileContents) => {
        dispatch(hideLoadingMessage());
        dispatch(pushBackup(path, fileContents));
        dispatch(parseFile(path, fileContents));
        dispatch(setLastSyncAt(addSeconds(new Date(), 5), path));
        dispatch(setDirty(false, path));
        dispatch(ActionCreators.clearHistory());
      })
      .catch(() => {
        dispatch(hideLoadingMessage());
        dispatch(setIsLoading(false, path));
        dispatch(setOrgFileErrorMessage(`File ${path} not found`));
      });
  };
};
