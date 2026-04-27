const { main } = require('../src/orphan-discovery');

main(process.argv).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
