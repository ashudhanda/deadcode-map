# Hand-written Django framework-keep cases. Every decorated item is
# invoked by Django itself, never by in-repo code: the template
# engine calls @register.filter / @register.simple_tag /
# @register.tag functions, the checks runner calls @register()
# functions, the ORM lookup registry takes @Field.register_lookup
# classes at definition time, signals call @receiver handlers, and
# the admin calls @admin.register classes, @admin.action methods and
# @admin.display callables. Only the decorator TEXT matters for the
# keep rule (the CLI matches it by substring), so the decorator
# names are used bare here, with no Django import.


@register.filter
def ordinal(value):
    return value


@register.simple_tag
def pagination_tag(page):
    return page


@register.tag("filter")
def result_tag(parser, token):
    return token


@receiver(post_save, sender=User)
def clear_tasks_handlers(sender, **kwargs):
    return sender


@admin.register(Page)
class FlatPageAdmin:
    pass


@Field.register_lookup
class OverlapsLookup:
    pass


@admin.action(description="Mark selected as published")
def make_published(modeladmin, request, queryset):
    return queryset


@admin.display(description="Status")
def status_display(obj):
    return obj


def tags_version():
    return 1
