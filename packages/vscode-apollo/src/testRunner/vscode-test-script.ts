import { resolve } from "path";
import { spawnSync, spawn } from "child_process";

// const buf = spawnSync(
//   `node ${resolve(
//     process.cwd(),
//     "..",
//     "..",
//     "node_modules",
//     "vscode",
//     "bin",
//     "test"
//   )}`,
//   {
//     shell: true,
//     env: {
//       CODE_TESTS_PATH: `${process.cwd()}/lib/testRunner`,
//       CODE_TESTS_WORKSPACE: process.cwd(),
//       DISPLAY: process.env.DISPLAY
//     }
//   }
// );

const stream = spawn(
  `node ${resolve(
    process.cwd(),
    "..",
    "..",
    "node_modules",
    "vscode",
    "bin",
    "test"
  )}`,
  {
    shell: true,
    env: {
      CODE_TESTS_PATH: `${process.cwd()}/lib/testRunner`,
      CODE_TESTS_WORKSPACE: process.cwd(),
      DISPLAY: process.env.DISPLAY
    }
  }
);

stream.stdout.on("data", data => {
  console.log(data.toString());
});

// stream.stdout.on("message", msg => {
//   console.log({ msg: msg.toString() });
// });

stream.stderr.on("data", err => {
  // Useful for debugging, but generally more noisy than useful
  // console.log({ err: err.toString() });
});

stream.on("close", code => {
  console.log({ code });
  if (code !== 0) {
    process.exit(code);
  }
});

// console.error(buf.stderr.toString());
// console.log(buf.stdout.toString());
