from pathlib import Path
# This script is intentionally tiny: CI replaces the corrupted public/index.html
# with the previously verified blob via the git tree before running tests.
print('restore marker script loaded')
