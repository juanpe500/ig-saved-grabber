/* IG Saved Grabber — service worker.
 * Opens the manager page when the toolbar icon is clicked, or when the
 * content-script panel asks for it. Focuses an existing manager tab instead
 * of piling up duplicates.
 */
const MANAGER_URL = chrome.runtime.getURL("manager.html");

async function openManager() {
  const tabs = await chrome.tabs.query({ url: MANAGER_URL });
  if (tabs.length) {
    await chrome.tabs.update(tabs[0].id, { active: true });
    if (tabs[0].windowId != null) {
      chrome.windows.update(tabs[0].windowId, { focused: true });
    }
  } else {
    await chrome.tabs.create({ url: MANAGER_URL });
  }
}

chrome.action.onClicked.addListener(openManager);

chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === "open_manager") openManager();
});
