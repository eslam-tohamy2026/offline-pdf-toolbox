/* Offline PDF Toolbox — background service worker.
   Only job: open the app tab when the toolbar icon is clicked
   (or focus it if it is already open). No network, no storage. */

chrome.action.onClicked.addListener(() => {
  const url = chrome.runtime.getURL("app/index.html");
  chrome.tabs.query({ url }, (tabs) => {
    if (tabs.length > 0) {
      chrome.tabs.update(tabs[0].id, { active: true });
      chrome.windows.update(tabs[0].windowId, { focused: true });
    } else {
      chrome.tabs.create({ url });
    }
  });
});
