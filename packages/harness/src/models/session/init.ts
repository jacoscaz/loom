import { type AbstractSessionModel } from "./abstract.js";
import { ConfigSessionModel, type ConfigModelBase, type Config } from "../../config/config.js";

import { OpenAISessionModel } from "./adapters/openai/openai.js";
import { MistralSessionModel } from "./adapters/mistral/mistral.js";
import { AnthropicSessionModel } from "./adapters/anthropic/anthropic.js";

export const initializeSessionModel = async (config: ConfigSessionModel): Promise<AbstractSessionModel> => {
  switch (config.adapter) {
    case 'openai':
      return new OpenAISessionModel(config);
    case 'mistral':
      // Config names the provider; the subclass owns its wire defaults
      // (thinking_wire_style 'mistral', strict_wire true) — ruled with
      // Jacopo 2026-10-07, log #3997.
      return new MistralSessionModel(config);
    case 'anthropic':
      return new AnthropicSessionModel(config);
    default: {
      // With every adapter case covered, config narrows to never here;
      // cast back to the base shape for the error message.
      const unknown = config as ConfigModelBase;
      throw new Error(`Unsupported model adapter: ${unknown.adapter}`);
    }
  }
};
