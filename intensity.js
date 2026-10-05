// "Rewrite intensity" setting: how much freedom the model has. Pure module (unit-tested in tests/unit.mjs).

export const INTENSITIES = {
    light: {
        label: 'Light touch',
        title: 'Only change what MUST change to account for the new reality; everything else stays verbatim.',
        text: `LIGHT TOUCH. Change only what MUST change to account for the new reality or narrative, for example pronouns, names, a specific physical detail, a changed status or relationship. Leave every other word, sentence and line exactly as it is, verbatim. Do not rephrase, reorder, tidy up, expand or "improve" anything that does not have to change.`,
    },
    balanced: {
        label: 'Balanced',
        title: 'Take a little liberty with the wording, but keep the essence of what was there.',
        text: `BALANCED. You may take a little more liberty: rephrase or extend sentences where that helps the entry reflect the new situation. Keep the essence, structure and voice of what was there, and keep information that is still true. Do not rewrite parts that are still accurate just to make them sound different.`,
    },
    heavy: {
        label: 'Heavy-handed',
        title: 'Rewrite sections as much as needed to fit the narrative and your instructions.',
        text: `HEAVY-HANDED. Rewrite sections as much as needed so the entry fits the narrative and the user's instructions. Consider the original context and keep facts that are still true, but you are free to restructure, merge, split, reorder or replace text. The formatting rules above still apply to the layout you produce.`,
    },
};

export const DEFAULT_INTENSITY = 'balanced';

/** Any stored value -> a valid level name. */
export const normalizeIntensity = (v) => (Object.hasOwn(INTENSITIES, v) ? v : DEFAULT_INTENSITY);

/** The section added to the system message. */
export function intensitySection(level) {
    const l = normalizeIntensity(level);
    return `## Rewrite intensity: ${INTENSITIES[l].label}\n${INTENSITIES[l].text}`;
}
