import {isArray, isString} from 'vega-util';
import {FieldDef, isFieldDef, vgField} from '../../fielddef';
import {StackOffset} from '../../stack';
import {StackTransform} from '../../transform';
import {duplicate, getFirstDefined, hash} from '../../util';
import {VgComparatorOrder, VgSort, VgTransform} from '../../vega.schema';
import {sortParams} from '../common';
import {UnitModel} from '../unit';
import {DataFlowNode} from './dataflow';

function getStackByFields(model: UnitModel): string[] {
  return model.stack.stackBy.reduce(
    (fields, by) => {
      const fieldDef = by.fieldDef;

      const _field = vgField(fieldDef);
      if (_field) {
        fields.push(_field);
      }
      return fields;
    },
    [] as string[]
  );
}

export interface StackComponent {
  /**
   * Faceted field.
   */
  facetby: string[];

  dimensionFieldDef?: FieldDef<string>;

  /**
   * Stack measure's field. Used in makeFromEncoding.
   */
  stackField: string;

  /**
   * Level of detail fields for each level in the stacked charts such as color or detail.
   * Used in makeFromEncoding.
   */
  stackby?: string[];

  /**
   * Field that determines order of levels in the stacked charts.
   * Used in both but optional in transform.
   */
  sort: VgSort;

  /** Mode for stacking marks.
   */
  offset: StackOffset;

  /**
   * Whether to impute the data before stacking. Used only in makeFromEncoding.
   */
  impute?: boolean;

  /**
   * The data fields to group by.
   */
  groupby?: string[];
  /**
   * Output field names of each stack field.
   */
  as: string[];
}

function isValidAsArray(as: string[] | string): as is string[] {
  return isArray(as) && as.every(s => isString(s)) && as.length > 1;
}

export class StackNode extends DataFlowNode {
  private _stack: StackComponent;

  public clone() {
    return new StackNode(null, duplicate(this._stack));
  }

  constructor(parent: DataFlowNode, stack: StackComponent) {
    super(parent);

    this._stack = stack;
  }

  public static makeFromTransform(parent: DataFlowNode, stackTransform: StackTransform) {
    const {stack, groupby, as, offset = 'zero'} = stackTransform;

    const sortFields: string[] = [];
    const sortOrder: VgComparatorOrder[] = [];
    if (stackTransform.sort !== undefined) {
      for (const sortField of stackTransform.sort) {
        sortFields.push(sortField.field);
        sortOrder.push(getFirstDefined(sortField.order, 'ascending'));
      }
    }
    const sort: VgSort = {
      field: sortFields,
      order: sortOrder
    };
    let normalizedAs: string[];
    if (isValidAsArray(as)) {
      normalizedAs = as;
    } else if (isString(as)) {
      normalizedAs = [as, as + '_end'];
    } else {
      normalizedAs = [stackTransform.stack + '_start', stackTransform.stack + '_end'];
    }

    return new StackNode(parent, {
      stackField: stack,
      groupby,
      offset,
      sort,
      facetby: [],
      as: normalizedAs
    });
  }

  public static makeFromEncoding(parent: DataFlowNode, model: UnitModel) {
    const stackProperties = model.stack;

    if (!stackProperties) {
      return null;
    }

    let dimensionFieldDef: FieldDef<string>;
    if (stackProperties.groupbyChannel) {
      dimensionFieldDef = model.fieldDef(stackProperties.groupbyChannel);
    }

    const stackby = getStackByFields(model);
    const orderDef = model.encoding.order;

    let sort: VgSort;
    if (isArray(orderDef) || isFieldDef(orderDef)) {
      sort = sortParams(orderDef);
    } else {
      // default = descending by stackFields
      // FIXME is the default here correct for binned fields?
      sort = stackby.reduce(
        (s, field) => {
          s.field.push(field);
          s.order.push('descending');
          return s;
        },
        {field: [], order: []}
      );
    }

    return new StackNode(parent, {
      dimensionFieldDef,
      stackField: model.vgField(stackProperties.fieldChannel),
      facetby: [],
      stackby,
      sort,
      offset: stackProperties.offset,
      impute: stackProperties.impute,
      as: [
        model.vgField(stackProperties.fieldChannel, {suffix: 'start', forAs: true}),
        model.vgField(stackProperties.fieldChannel, {suffix: 'end', forAs: true})
      ]
    });
  }

  get stack(): StackComponent {
    return this._stack;
  }

  public addDimensions(fields: string[]) {
    this._stack.facetby = this._stack.facetby.concat(fields);
  }

  public dependentFields() {
    const out = {};

    out[this._stack.stackField] = true;

    this.getGroupbyFields().forEach(f => (out[f] = true));
    this._stack.facetby.forEach(f => (out[f] = true));
    const field = this._stack.sort.field;
    isArray(field) ? field.forEach(f => (out[f] = true)) : (out[field] = true);

    return out;
  }

  public producedFields() {
    return this._stack.as.reduce((result, item) => {
      result[item] = true;
      return result;
    }, {});
  }

  public hash() {
    return `Stack ${hash(this._stack)}`;
  }

  private getGroupbyFields() {
    const {dimensionFieldDef, impute, groupby} = this._stack;
    if (dimensionFieldDef) {
      if (dimensionFieldDef.bin) {
        if (impute) {
          // For binned group by field with impute, we calculate bin_mid
          // as we cannot impute two fields simultaneously
          return [vgField(dimensionFieldDef, {binSuffix: 'mid'})];
        }
        return [
          // For binned group by field without impute, we need both bin (start) and bin_end
          vgField(dimensionFieldDef, {}),
          vgField(dimensionFieldDef, {binSuffix: 'end'})
        ];
      }
      return [vgField(dimensionFieldDef)];
    }
    return groupby || [];
  }

  public assemble(): VgTransform[] {
    const transform: VgTransform[] = [];
    const {facetby, dimensionFieldDef, stackField: field, stackby, sort, offset, impute, as} = this._stack;

    // Impute
    if (impute && dimensionFieldDef) {
      if (dimensionFieldDef.bin) {
        // As we can only impute one field at a time, we need to calculate
        // mid point for a binned field
        transform.push({
          type: 'formula',
          expr:
            '(' +
            vgField(dimensionFieldDef, {expr: 'datum'}) +
            '+' +
            vgField(dimensionFieldDef, {expr: 'datum', binSuffix: 'end'}) +
            ')/2',
          as: vgField(dimensionFieldDef, {binSuffix: 'mid', forAs: true})
        });
      }

      transform.push({
        type: 'impute',
        field,
        groupby: stackby,
        key: vgField(dimensionFieldDef, {binSuffix: 'mid'}),
        method: 'value',
        value: 0
      });
    }

    // Stack
    transform.push({
      type: 'stack',
      groupby: this.getGroupbyFields().concat(facetby),
      field,
      sort,
      as,
      offset
    });

    return transform;
  }
}
