FLAG = True

if FLAG:
    class _GeometryType:
        pass

    class _GeographyType:
        pass

    def _make_adapters(geo_oid):
        class _BaseDumper:
            def get_key(self, obj):
                if obj.is_geometry:
                    return _GeographyType if obj.geography else _GeometryType
                return None

            def upgrade(self, obj):
                return self._Dumper(_GeometryType)

        class _TextDumper(_BaseDumper):
            pass

        return _TextDumper


class DatabaseWrapper:
    def register_adapters(self):
        return _make_adapters(1)


def _dead_helper():
    return 99


class _DeadType:
    pass
