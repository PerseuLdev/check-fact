chrome.sidePanel.setPanelBehavior({openPanelOnActionClick:true}).catch(console.error);
// Content scripts never receive the local pairing credential.
chrome.storage.local.setAccessLevel({accessLevel:'TRUSTED_CONTEXTS'}).catch(console.error);
