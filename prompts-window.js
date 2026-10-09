// Prompts window: opened from the "Prompts" button in the modal header. Holds every editable prompt text that used to sit
// above the chat (system prompt, rewrite intensity wording, change type wording, the reply format rules per reply style,
// and the new entry prompt), each with Restore default and, for the rules, a warning when an edit would break reading
// the reply. Every edit is written to the extension settings as you type (same storage rules as before: only real edits
// are stored), and Send / Regenerate read the settings when they build the prompt, so edits apply to the next request.

import { Popup, POPUP_TYPE } from '../../../popup.js';
import { getSettings, DEFAULT_SYSTEM_PROMPT } from './settings.js';
import { INTENSITIES } from './intensity.js';
import { CHANGE_TYPES } from './changetype.js';
import { DEFAULT_FORMAT_RULES, checkFormatRules, FORMAT_RULES_NOTE, DEFAULT_PASSAGE_RULES, checkPassageRules, PASSAGE_RULES_NOTE } from './rules.js';
import { DEFAULT_CREATE_SYSTEM_PROMPT, DEFAULT_CREATE_FORMAT_RULES, checkCreateRules, CREATE_RULES_NOTE } from './create-core.js';

/** True when any prompt text differs from its default (shown as "edited" on the header button). */
export function promptsEdited(settings) {
    return String(settings.systemPrompt ?? '').trim() !== DEFAULT_SYSTEM_PROMPT.trim()
        || Object.keys(settings.intensityTexts ?? {}).length > 0
        || Object.keys(settings.changeTypeTexts ?? {}).length > 0
        || !!settings.formatRules || !!settings.passageFormatRules
        || String(settings.createSystemPrompt ?? '').trim() !== DEFAULT_CREATE_SYSTEM_PROMPT.trim()
        || !!settings.createFormatRules;
}

const TEMPLATE = `
<div class="lorerev_prompts_root">
    <h3 class="lorerev_prompts_heading">Prompts</h3>
    <div class="lorerev_dim lorerev_prompts_intro">The texts LoreReviser sends to the model. Click a section to open it. Changes are saved as you type and are used from the next Send or Regenerate on; each text has a <b>Restore default</b> button. “(edited)” marks texts that differ from the default.</div>
    <div class="lorerev_prompts">
            <details class="lorerev_system">
                <summary>System prompt <span class="lorerev_edited" id="lorerev_system_edited"></span></summary>
                <textarea id="lorerev_system" class="text_pole" rows="6"></textarea>
                <div class="menu_button lorerev_restore" id="lorerev_system_reset" title="Put the original system prompt back">Restore default</div>
            </details>
            <details class="lorerev_system" id="lorerev_int_box">
                <summary>Rewrite intensity wording <span class="lorerev_edited" id="lorerev_int_edited"></span></summary>
                <div class="lorerev_dim">The text that is added to the system message for the intensity chosen in the LoreReviser header. Each level is edited separately. The heading <code>## Rewrite intensity: &lt;level&gt;</code> is added automatically and stays fixed, so the system prompt's reference to the "Rewrite intensity" section remains valid.</div>
                ${Object.entries(INTENSITIES).map(([k, v]) => `
                <div class="lorerev_part">
                    <div class="lorerev_part_head"><b>${v.label}</b> <span class="lorerev_edited" data-edited="${k}"></span>
                        <div class="menu_button lorerev_restore" data-restore="${k}" title="Put the original ${v.label} wording back">Restore default</div></div>
                    <textarea class="text_pole lorerev_int_text" data-level="${k}" rows="3"></textarea>
                </div>`).join('')}
            </details>
            <details class="lorerev_system" id="lorerev_ct_box">
                <summary>Change type wording <span class="lorerev_edited" id="lorerev_ct_edited"></span></summary>
                <div class="lorerev_dim">The text that is added to the system message, after the rewrite intensity, for the change type chosen in the LoreReviser header (Development or Retcon). Each type is edited separately. The heading <code>## Change type: &lt;type&gt;</code> is added automatically and stays fixed, so the system prompt's reference to the "Change type" section remains valid.</div>
                ${Object.entries(CHANGE_TYPES).map(([k, v]) => `
                <div class="lorerev_part">
                    <div class="lorerev_part_head"><b>${v.label}</b> <span class="lorerev_edited" data-ct-edited="${k}"></span>
                        <div class="menu_button lorerev_restore" data-restore-ct="${k}" title="Put the original ${v.label} wording back">Restore default</div></div>
                    <textarea class="text_pole lorerev_ct_text" data-type="${k}" rows="4"></textarea>
                </div>`).join('')}
            </details>
            <details class="lorerev_system" id="lorerev_rules_box">
                <summary>Reply format rules (advanced) <span class="lorerev_edited" id="lorerev_rules_box_edited"></span></summary>
                <div class="lorerev_dim">Appended to the system message, last. They tell the model how to answer so LoreReviser can read the reply. There is one set per <b>Reply style</b> (chosen in the LoreReviser header); only the set for the chosen style is sent. A warning appears below a set if an edit would break reading the reply.</div>
                <div class="lorerev_part" id="lorerev_prules_part">
                    <div class="lorerev_part_head"><b>Changed passages only</b> <span class="lorerev_edited" id="lorerev_prules_edited"></span>
                        <div class="menu_button lorerev_restore" id="lorerev_prules_reset" title="Put the original rules for “Changed passages only” back">Restore default</div></div>
                    <div class="lorerev_dim">Keep it a JSON array of objects with an <code>id</code> and an <code>edits</code> list of <code>{find, replace}</code>.</div>
                    <div id="lorerev_prules_warn" class="lorerev_rules_warn" style="display:none"></div>
                    <textarea id="lorerev_prules" class="text_pole" rows="10"></textarea>
                </div>
                <div class="lorerev_part" id="lorerev_rules_part">
                    <div class="lorerev_part_head"><b>Full rewrite</b> <span class="lorerev_edited" id="lorerev_rules_edited"></span>
                        <div class="menu_button lorerev_restore" id="lorerev_rules_reset" title="Put the original rules for “Full rewrite” back">Restore default</div></div>
                    <div class="lorerev_dim">Keep it a JSON array of objects with an <code>id</code> and the full <code>content</code>.</div>
                    <div id="lorerev_rules_warn" class="lorerev_rules_warn" style="display:none"></div>
                    <textarea id="lorerev_rules" class="text_pole" rows="10"></textarea>
                </div>
            </details>
            <details class="lorerev_system" id="lorerev_create_box">
                <summary>New entry prompt <span class="lorerev_edited" id="lorerev_create_edited"></span></summary>
                <div class="lorerev_dim">Used instead of the system prompt and reply format rules above when you ask for <b>New entries</b>. The <code>## Change type: &lt;type&gt;</code> section (chosen in the LoreReviser header) is added between them; the rewrite intensity is not used for new entries, because there is no existing text to rewrite.</div>
                <div class="lorerev_part">
                    <div class="lorerev_part_head"><b>System prompt for new entries</b> <span class="lorerev_edited" id="lorerev_create_sys_edited"></span>
                        <div class="menu_button lorerev_restore" id="lorerev_create_sys_reset" title="Put the original new-entry system prompt back">Restore default</div></div>
                    <textarea id="lorerev_create_sys" class="text_pole" rows="6"></textarea>
                </div>
                <div class="lorerev_part">
                    <div class="lorerev_part_head"><b>Reply format rules for new entries (advanced)</b> <span class="lorerev_edited" id="lorerev_create_rules_edited"></span>
                        <div class="menu_button lorerev_restore" id="lorerev_create_rules_reset" title="Put the original new-entry reply format rules back">Restore default</div></div>
                    <div id="lorerev_create_rules_warn" class="lorerev_rules_warn" style="display:none"></div>
                    <textarea id="lorerev_create_rules" class="text_pole" rows="8"></textarea>
                </div>
            </details>
    </div>
</div>`;

/**
 * Opens the Prompts window on top of the LoreReviser modal.
 * @param {object} [p]
 * @param {() => void} [p.onClose] called after the window closes (e.g. to update the header button's "edited" mark)
 */
export async function openPromptsWindow({ onClose } = {}) {
    const { settings, save } = getSettings();
    const $root = $(TEMPLATE);

    // --- system prompt ---
    const $system = $root.find('#lorerev_system').val(settings.systemPrompt);
    const markEdited = ($el, on) => $el.text(on ? '(edited)' : '');
    const refreshSystemMark = () => markEdited($root.find('#lorerev_system_edited'), settings.systemPrompt.trim() !== DEFAULT_SYSTEM_PROMPT.trim());
    $system.on('input', () => { settings.systemPrompt = String($system.val()); refreshSystemMark(); save(); });
    $root.find('#lorerev_system_reset').on('click', () => {
        $system.val(DEFAULT_SYSTEM_PROMPT).trigger('input');
    });
    refreshSystemMark();

    // --- rewrite intensity wording (one editable text per level; settings keep only the edited ones) ---
    const refreshIntMarks = () => {
        let any = false;
        for (const k of Object.keys(INTENSITIES)) {
            const on = k in settings.intensityTexts;
            any ||= on;
            markEdited($root.find(`[data-edited="${k}"]`), on);
        }
        markEdited($root.find('#lorerev_int_edited'), any);
    };
    $root.find('.lorerev_int_text').each(function () {
        const $t = $(this), k = String($t.data('level'));
        const defaults = INTENSITIES[k].text;
        $t.val(settings.intensityTexts[k] ?? defaults);
        $t.on('input', () => {
            const v = String($t.val());
            // An empty or unchanged text means "use the default"; only real edits are stored, so default improvements still reach you.
            if (!v.trim() || v.trim() === defaults.trim()) delete settings.intensityTexts[k]; else settings.intensityTexts[k] = v;
            refreshIntMarks(); save();
        });
        $t.on('change', () => { if (!String($t.val()).trim()) $t.val(defaults); }); // left empty: show the default that is used
    });
    $root.find('[data-restore]').on('click', function () {
        const k = String($(this).data('restore'));
        $root.find(`.lorerev_int_text[data-level="${k}"]`).val(INTENSITIES[k].text).trigger('input');
    });
    refreshIntMarks();

    // --- change type wording (same behaviour as the intensity wording) ---
    const refreshCtMarks = () => {
        let any = false;
        for (const k of Object.keys(CHANGE_TYPES)) {
            const on = k in settings.changeTypeTexts;
            any ||= on;
            markEdited($root.find(`[data-ct-edited="${k}"]`), on);
        }
        markEdited($root.find('#lorerev_ct_edited'), any);
    };
    $root.find('.lorerev_ct_text').each(function () {
        const $t = $(this), k = String($t.data('type'));
        const defaults = CHANGE_TYPES[k].text;
        $t.val(settings.changeTypeTexts[k] ?? defaults);
        $t.on('input', () => {
            const v = String($t.val());
            if (!v.trim() || v.trim() === defaults.trim()) delete settings.changeTypeTexts[k]; else settings.changeTypeTexts[k] = v;
            refreshCtMarks(); save();
        });
        $t.on('change', () => { if (!String($t.val()).trim()) $t.val(defaults); });
    });
    $root.find('[data-restore-ct]').on('click', function () {
        const k = String($(this).data('restore-ct'));
        $root.find(`.lorerev_ct_text[data-type="${k}"]`).val(CHANGE_TYPES[k].text).trigger('input');
    });
    refreshCtMarks();

    // --- reply format rules, one set per reply style, each with a warning when it would break the parser ---
    const ruleSets = [
        { key: 'passageFormatRules', box: '#lorerev_prules', warn: '#lorerev_prules_warn', mark: '#lorerev_prules_edited', reset: '#lorerev_prules_reset', def: DEFAULT_PASSAGE_RULES, check: checkPassageRules, note: PASSAGE_RULES_NOTE },
        { key: 'formatRules', box: '#lorerev_rules', warn: '#lorerev_rules_warn', mark: '#lorerev_rules_edited', reset: '#lorerev_rules_reset', def: DEFAULT_FORMAT_RULES, check: checkFormatRules, note: FORMAT_RULES_NOTE },
    ];
    const refreshRulesBox = () => markEdited($root.find('#lorerev_rules_box_edited'), ruleSets.some(r => !!settings[r.key]));
    for (const r of ruleSets) {
        const $box = $root.find(r.box).val(settings[r.key] || r.def);
        const $warn = $root.find(r.warn);
        const refresh = () => {
            const problems = r.check(String($box.val()));
            if (problems.length) {
                $warn.text(`Warning: these rules may break reading the reply (${problems.join('; ')}). ${r.note} If the model does not answer in that format, no changes can be shown. Use "Restore default" to go back to the original rules.`).show();
            } else $warn.hide().text('');
            markEdited($root.find(r.mark), !!settings[r.key]);
            refreshRulesBox();
        };
        $box.on('input', () => {
            const v = String($box.val());
            // Only real edits are stored ('' = the default), so improvements of the default still reach you.
            settings[r.key] = !v.trim() || v.trim() === r.def.trim() ? '' : v;
            refresh(); save();
        });
        $box.on('change', () => { if (!String($box.val()).trim()) { $box.val(r.def); refresh(); } });
        $root.find(r.reset).on('click', () => $box.val(r.def).trigger('input'));
        refresh();
    }

    // --- new entry prompt: own system prompt and reply-format rules (same storage rules as above) ---
    const $cSys = $root.find('#lorerev_create_sys').val(settings.createSystemPrompt);
    const $cRules = $root.find('#lorerev_create_rules').val(settings.createFormatRules || DEFAULT_CREATE_FORMAT_RULES);
    const $cRulesWarn = $root.find('#lorerev_create_rules_warn');
    const refreshCreateMarks = () => {
        const sysEdited = settings.createSystemPrompt.trim() !== DEFAULT_CREATE_SYSTEM_PROMPT.trim();
        markEdited($root.find('#lorerev_create_sys_edited'), sysEdited);
        markEdited($root.find('#lorerev_create_rules_edited'), !!settings.createFormatRules);
        markEdited($root.find('#lorerev_create_edited'), sysEdited || !!settings.createFormatRules);
        const problems = checkCreateRules(String($cRules.val()));
        if (problems.length) $cRulesWarn.text(`Warning: these rules may break reading the reply (${problems.join('; ')}). ${CREATE_RULES_NOTE} Use "Restore default" to go back to the original rules.`).show();
        else $cRulesWarn.hide().text('');
    };
    $cSys.on('input', () => { settings.createSystemPrompt = String($cSys.val()).trim() ? String($cSys.val()) : DEFAULT_CREATE_SYSTEM_PROMPT; refreshCreateMarks(); save(); });
    $cSys.on('change', () => { if (!String($cSys.val()).trim()) $cSys.val(DEFAULT_CREATE_SYSTEM_PROMPT); });
    $root.find('#lorerev_create_sys_reset').on('click', () => $cSys.val(DEFAULT_CREATE_SYSTEM_PROMPT).trigger('input'));
    $cRules.on('input', () => {
        const v = String($cRules.val());
        settings.createFormatRules = !v.trim() || v.trim() === DEFAULT_CREATE_FORMAT_RULES.trim() ? '' : v;
        refreshCreateMarks(); save();
    });
    $cRules.on('change', () => { if (!String($cRules.val()).trim()) { $cRules.val(DEFAULT_CREATE_FORMAT_RULES); refreshCreateMarks(); } });
    $root.find('#lorerev_create_rules_reset').on('click', () => $cRules.val(DEFAULT_CREATE_FORMAT_RULES).trigger('input'));
    refreshCreateMarks();

    const popup = new Popup($root, POPUP_TYPE.TEXT, '', { wide: true, large: true, okButton: 'Close', cancelButton: false, allowVerticalScrolling: false });
    popup.dlg.classList.add('lorerev_prompts_popup');
    await popup.show();
    onClose?.();
}
