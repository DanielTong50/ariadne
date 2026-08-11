import { AppContext } from '../appContext';
import { DecomposedRequirement } from '../contextEngine/contextEngine';

/**
 * /ariadne-decompose — runs the Context Engine over raw text and returns
 * candidate requirements. Deliberately does NOT write to the store: extracted
 * requirements are staged for review in the Translator panel before the
 * user commits them, so nothing lands in the project's requirements list
 * without a look. See TranslatorViewProvider's 'extractRequirements' /
 * 'commitRequirements' message handlers.
 */
export async function decomposeText(app: AppContext, text: string): Promise<DecomposedRequirement[]> {
  const trimmed = text.trim();
  if (!trimmed) return [];
  return app.engine.decompose(trimmed);
}
