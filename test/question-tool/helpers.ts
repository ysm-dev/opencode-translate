import type { QuestionArgs } from "../../src/question-tool"

export const sampleArgs: QuestionArgs = {
  questions: [
    {
      question: "Are you sure?",
      header: "Confirm",
      options: [
        { label: "Yes, delete", description: "This cannot be undone." },
        { label: "No, cancel", description: "Keep the file." },
      ],
      multiple: false,
      custom: true,
    },
  ],
}

export function cloneSampleArgs(): QuestionArgs {
  return JSON.parse(JSON.stringify(sampleArgs)) as QuestionArgs
}
