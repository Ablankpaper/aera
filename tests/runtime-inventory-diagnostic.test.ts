import { expect, it } from "vitest";

import {
  runtimeInventoryDiagnosticErrorFields,
  type RuntimeInventoryDiagnosticErrorFields,
} from "../src/main/runtime-inventory-diagnostic";

it("classifies helper failures without exposing filesystem paths", () => {
  const error = Object.assign(
    new Error(
      "EACCES: permission denied, open 'C:\\Users\\secret\\runtime.bin'",
    ),
    { code: "EACCES" },
  );

  const fields: RuntimeInventoryDiagnosticErrorFields =
    runtimeInventoryDiagnosticErrorFields(error);

  expect(fields).toEqual({
    errorName: "Error",
    errorCode: "EACCES",
    errorMessageClass: "access-denied",
    errorMessageLength: expect.any(Number),
    errorMessageSha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
  });
  expect(JSON.stringify(fields)).not.toContain("secret");
  expect(JSON.stringify(fields)).not.toContain("runtime.bin");
});
