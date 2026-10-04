// LoreReviser: entry point. Adds a wand-menu item that opens the LoreReviser modal.
// Milestone 2: UI only, no model calls.

import { openModal } from './modal.js';
import { getSettings } from './settings.js';

/** Adds the item to the wand (extensions) menu. ST has no registration API, so we append to #extensionsMenu. */
function addWandEntry() {
    if ($('#lorereviser_wand_container').length) return; // already added
    $('#extensionsMenu').append(`
        <div id="lorereviser_wand_container" class="extension_container">
            <div id="lorereviser_open" class="list-group-item flex-container flexGap5" title="Revise lorebooks from the chat">
                <div class="fa-solid fa-book-open extensionsMenuExtensionButton"></div>
                <span>LoreReviser</span>
            </div>
        </div>`);
    $('#lorereviser_open').on('click', openModal);
}

jQuery(() => {
    getSettings(); // make sure defaults exist
    addWandEntry();
});
