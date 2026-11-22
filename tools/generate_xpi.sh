#! /bin/sh

_HOME2_=$(dirname $0)
export _HOME2_
_HOME_=$(cd $_HOME2_;pwd)
export _HOME_

basedir="$_HOME_""/../"

cd "$basedir"
cd easyfill/
rm -fv easyfill.xpi
zip -r easyfill.xpi icons/ manifest.json src/
