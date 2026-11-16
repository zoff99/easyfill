#! /bin/sh

_HOME2_=$(dirname $0)
export _HOME2_
_HOME_=$(cd $_HOME2_;pwd)
export _HOME_

basedir="$_HOME_""/../"

cd "$basedir"
cd easyfill/

final_rc=0

for i in $(find . -type f \( -name ".mjs" -o -name "*.html" -o -name "*.css" -o -name "*.js" -o -name "*.json" \) 2>/dev/null \
       | sort 2>/dev/null) ; do
    "$basedir"/tools/check_nonascii.sh -a \
      0900 \
      "$i"
    rc=$?
    if [ "$rc""x" != "0x" ]; then
        final_rc=$rc
    fi
done

exit "$final_rc"

