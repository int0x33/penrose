import * as React from "react";
import MonacoEditor, { useMonaco } from "@monaco-editor/react";
import { useCallback, useEffect } from "react";
import {
  SubstanceCompletions,
  SubstanceConfig,
  SubstanceLanguageTokens,
} from "./languages/SubstanceConfig";
import { IRange } from "monaco-editor";
import { Env } from "@penrose/core";
import { editor } from "monaco-editor";

export const monacoOptions: editor.IStandaloneEditorConstructionOptions = {
  automaticLayout: true,
  readOnly: true,
  minimap: { enabled: false },
  wordWrap: "on",
  lineNumbers: "off",
  fontSize: 16,
  scrollBeyondLastLine: false,
};

const Listing = ({
  value,
  env,
}: {
  value: string;
  env: Env;
  numOpen: number;
}) => {
  const monaco = useMonaco();
  const provideCompletion = useCallback(
    (model, position) => {
      const word = model.getWordUntilPosition(position);
      const range: IRange = {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: word.startColumn,
        endColumn: word.endColumn,
      };
      return { suggestions: SubstanceCompletions(range, env) };
    },
    [env]
  );
  useEffect(() => {
    if (monaco) {
      monaco.languages.register({ id: "substance" });
      monaco.languages.setLanguageConfiguration("substance", SubstanceConfig);
      if (env) {
        monaco.languages.setMonarchTokensProvider(
          "substance",
          SubstanceLanguageTokens(env)
        );
        const dispose = monaco.languages.registerCompletionItemProvider(
          "substance",
          {
            provideCompletionItems: provideCompletion,
          }
        );
        return () => {
          // prevents duplicates
          dispose.dispose();
        };
      }
    }
  }, [monaco, provideCompletion, env]);
  return (
    <MonacoEditor
      value={value}
      width={`400px`}
      height={`300px`}
      defaultLanguage="substance"
      options={monacoOptions}
    />
  );
};

export default Listing;
